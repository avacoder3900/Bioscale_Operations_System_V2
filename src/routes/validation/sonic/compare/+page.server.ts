import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession } from '$lib/server/db';
import { loadFingerprints, referenceFilter } from '$lib/server/sonic/analyze';
import { compareFingerprints } from '$lib/server/sonic/compare';
import { ENVELOPE_K, PASS_INSIDE_PCT, MIN_REFERENCES, TICK_S } from '$lib/server/sonic/constants';
import type { PageServerLoad } from './$types';

/**
 * Sonic compare (VALIDATION-08 §8.3): line up any analyzed recordings and show
 * how they differ over time, section by section. Everything is computed from
 * stored fingerprints — no audio is touched here.
 *
 *   ?ids=a,b,c              recordings to compare (2+)
 *   &sections=110-130,40-57 custom sections (default: automatic P#/B#)
 *   &against=reference      judge each against the reference set of their assay
 */
/** Each fingerprint is ~150 KB and the compare is O(n²) in places; keep a request bounded. */
const MAX_COMPARE = 30;

/** "BT-M01-0000-0210" → "SPU 210" (the number people call the unit by); anything else unchanged. */
const spuShort = (udi: string) => {
	const m = /-0*(\d+)$/.exec(udi);
	return m ? `SPU ${m[1]}` : udi;
};

const r1 = (v: number | null) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// Picker: every analyzed recording, without fingerprints.
	const available = ((await ValidationSession.find({ type: 'sonic', 'results.0.processedData.fingerprint': { $type: 'object' } })
		.select('spuUdi createdAt results.rawData.assay results.rawData.fileName results.processedData.reference')
		.sort({ createdAt: -1 })
		.limit(300)
		.lean()) as any[]).map((s) => ({
		id: s._id as string,
		spuUdi: (s.spuUdi ?? '?') as string,
		short: spuShort((s.spuUdi ?? '?') as string),
		assay: (s.results?.[0]?.rawData?.assay ?? null) as string | null,
		fileName: (s.results?.[0]?.rawData?.fileName ?? null) as string | null,
		reference: !!s.results?.[0]?.processedData?.reference?.on,
		at: s.createdAt ? new Date(s.createdAt).toISOString() : null
	}));

	const ids = [...new Set((url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
	const sections = url.searchParams.get('sections')?.trim() || null;
	const againstRefs = url.searchParams.get('against') === 'reference';
	const base = { available, ids, sections, againstRefs, tickS: TICK_S, envelopeK: ENVELOPE_K, passPct: PASS_INSIDE_PCT, minReferences: MIN_REFERENCES };
	if (ids.length < (againstRefs ? 1 : 2)) return { ...base, result: null, error: null };
	if (ids.length > MAX_COMPARE) return { ...base, result: null, error: `Compare at most ${MAX_COMPARE} recordings at a time (${ids.length} selected).` };

	const chosen = await loadFingerprints({ _id: { $in: ids } });
	const byId = new Map(chosen.map((c) => [c.id, c]));
	let rows = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
	const missing = ids.filter((id) => !byId.has(id));

	let referenceIds: string[] | null = null;
	if (againstRefs) {
		const assays = [...new Set(rows.map((r) => r.assay))];
		if (assays.length !== 1 || !assays[0]) {
			return { ...base, result: null, error: 'To judge against the reference set, pick recordings of one assay (set the assay on each first).' };
		}
		const refs = await loadFingerprints(referenceFilter(assays[0]));
		referenceIds = refs.map((r) => r.id);
		// References go first (the first recording is the timing reference), then the rest.
		rows = [...refs, ...rows.filter((r) => !referenceIds!.includes(r.id))];
	}
	if (rows.length < 2) return { ...base, result: null, error: 'Need at least two analyzed recordings.' };

	const labelCount = new Map<string, number>();
	rows.forEach((r) => labelCount.set(r.spuUdi, (labelCount.get(r.spuUdi) ?? 0) + 1));
	const items = rows.map((r) => ({
		id: r.id,
		label: (labelCount.get(r.spuUdi) ?? 0) > 1 && r.at ? `${spuShort(r.spuUdi)} (${r.at.slice(5, 16).replace('T', ' ')})` : spuShort(r.spuUdi),
		fp: r.fp
	}));

	let c;
	try {
		c = compareFingerprints(items, { sections, referenceIds });
	} catch (err) {
		return { ...base, result: null, error: err instanceof Error ? err.message : String(err) };
	}

	// Running stretches of the reference/group, for grey shading.
	const shade: [number, number][] = [];
	c.ref.active.forEach((on, k) => {
		if (!on) return;
		const a = c.t[k] - 0.25;
		const last = shade[shade.length - 1];
		if (last && Math.abs(last[1] - a) < 1e-6) last[1] = c.t[k] + 0.25;
		else shade.push([a, c.t[k] + 0.25]);
	});

	return {
		...base,
		error: missing.length ? `${missing.length} selected recording(s) are not analyzed yet and were left out.` : null,
		result: {
			mode: c.mode,
			against: c.against,
			scoredAgainst: c.scoredAgainst,
			sectionsCustom: c.sectionsCustom,
			items: rows.map((r, i) => ({
				id: r.id,
				label: items[i].label,
				spuUdi: r.spuUdi,
				spuId: r.spuId,
				assay: r.assay,
				fileName: r.fileName,
				reference: r.reference,
				isReference: referenceIds?.includes(r.id) ?? false,
				offset: Math.round(c.offsets[i] * 100) / 100
			})),
			window: c.window.map((v) => Math.round(v * 10) / 10) as [number, number],
			t: c.t,
			shade,
			series: c.series.map((s) => ({ levelSmooth: s.levelSmooth.map(r1), domHz: s.domHz.map((v) => (v == null ? null : Math.round(v))) })),
			refDomHz: c.ref.domHz.map((v) => (v == null ? null : Math.round(v))),
			sim: c.sim.map((s) => ({
				dHz: s.dHz.map((v) => (v == null ? null : Math.round(v))),
				dLvl: s.dLvl.map(r1),
				shapeDb: s.shapeDb.map(r1),
				runningS: s.runningS,
				avgAbsHz: r1(s.avgAbsHz),
				avgAbsPct: r1(s.avgAbsPct),
				matchPct: s.matchPct == null ? null : Math.round(s.matchPct),
				avgAbsLvl: r1(s.avgAbsLvl),
				avgShape: r1(s.avgShape),
				peakDb: r1(s.peakDb),
				peakT: r1(s.peakT),
				minDb: r1(s.minDb),
				minT: r1(s.minT),
				medianHz: s.medianHz == null ? null : Math.round(s.medianHz)
			})),
			phases: c.phases.map(([a, b]) => [r1(a), r1(b)] as [number, number]),
			pstats: c.pstats.map((row) => row.map((p) => ({ avgDb: r1(p.avgDb), peakDb: r1(p.peakDb), hz: p.hz == null ? null : Math.round(p.hz) }))),
			extremes: c.extremes.map((row) => row.map(([t, hz, kind]) => [t, Math.round(hz), kind] as [number, number, 'peak' | 'valley'])),
			sections: c.sections.map((s) => ({ name: s.name, a: r1(s.a)!, b: r1(s.b)! })),
			scores: c.scores.map((row) =>
				row.map((s) => (s ? { loudIn: Math.round(s.loudIn), specIn: Math.round(s.specIn), loudZ: r1(s.loudZ), specZ: r1(s.specZ), pass: s.pass } : null))
			),
			envelopes: c.envelopes.map((e) => ({
				name: e.name,
				a: Math.round(e.a * 10) / 10,
				b: Math.round(e.b * 10) / 10,
				t: e.t,
				loud: e.loud.map((row) => row.map(r1)),
				loudMu: e.loudMu.map(r1),
				loudSd: e.loudSd.map(r1),
				spec: e.spec.map((row) => row.map(r1)),
				specMu: e.specMu.map(r1),
				specSd: e.specSd.map(r1)
			})),
			tones: c.tones
		}
	};
};
