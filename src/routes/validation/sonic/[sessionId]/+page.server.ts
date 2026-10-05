import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, User } from '$lib/server/db';
import { liveVerdict, recordingUrl } from '$lib/server/sonic/analyze';
import { ACTIVE_RISE_DB, FRAME_S, TICK_S, MIN_REFERENCES, PASS_INSIDE_PCT } from '$lib/server/sonic/constants';
import { percentile } from '$lib/server/sonic/stats';
import type { Fingerprint } from '$lib/server/sonic/features';
import { sonicTimeline } from '$lib/server/sonic/review';
import { planSteps as toPlanSteps } from '$lib/server/sonic/timeline';
import { expectedDurations } from '$lib/server/sonic/landmarks';
import type { PlanStep } from '$lib/sonic-placement';
import { suggestWindow } from '$lib/server/sonic/window';
import { loadIgnoreRules } from '$lib/server/sonic/ignore';
import type { PageServerLoad } from './$types';

/**
 * One sonic recording: trim & verify the test window, the step-mapped anomaly
 * review (SONIC workflow steps 5–6), and the fingerprint charts + advisory
 * verdict (VALIDATION-08 §8.2).
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const s = (await ValidationSession.findById(params.sessionId).lean()) as any;
	if (!s || s.type !== 'sonic') throw error(404, 'Sonic recording not found');
	const res = s.results?.[0] ?? {};
	const raw = res.rawData ?? {};
	const p = res.processedData ?? {};
	const fp = (p.fingerprint ?? null) as Fingerprint | null;
	const user = s.userId ? ((await User.findById(s.userId, { username: 1 }).lean()) as any) : null;

	let charts = null;
	if (fp) {
		const quiet = percentile(fp.levelDb, 20);
		const binT = fp.levelDb.map((_, b) => (b + 0.5) * fp.binS);
		// Log-spaced spectrum points (≈400) keep the chart light.
		const psdX: number[] = [];
		const psdY: number[] = [];
		let lastF = 0;
		fp.psdDb.forEach((v, k) => {
			const f = k * fp.psdHzStep;
			if (f < 50) return;
			if (f < lastF * 1.01) return;
			lastF = f;
			psdX.push(Math.round(f));
			psdY.push(v);
		});
		charts = {
			envT: fp.envDb.map((_, i) => Math.round(i * FRAME_S * 100) / 100),
			envDb: fp.envDb,
			binT,
			levelDb: fp.levelDb,
			domHz: fp.domHz.map((h, b) => (fp.levelDb[b] > quiet + ACTIVE_RISE_DB ? h : null)),
			// ≤ 400 columns for the heatmap (power-average neighbouring bins).
			bands: (() => {
				const stride = Math.max(1, Math.ceil(fp.bands.length / 400));
				const out: number[][] = [];
				for (let b = 0; b < fp.bands.length; b += stride) {
					const grp = fp.bands.slice(b, b + stride);
					out.push(grp[0].map((_, q) => Math.round(10 * Math.log10(grp.reduce((s, r) => s + 10 ** (r[q] / 10), 0) / grp.length) * 10) / 10));
				}
				return out;
			})(),
			psdX,
			psdY,
			events: fp.events,
			summary: fp.summary,
			durationS: fp.durationS
		};
	}

	// SONIC plan (48 steps) and the review state.
	let plan: { totalS: number; steps: PlanStep[]; firstMoveS: number; expected: number[] } | null = null;
	try {
		const tl = await sonicTimeline();
		plan = {
			totalS: tl.totalS,
			firstMoveS: tl.steps.find((x) => x.kind !== 'start' && x.moving)?.t0 ?? 0,
			steps: toPlanSteps(tl),
			expected: expectedDurations(tl, null)
		};
	} catch (err) {
		console.warn(`[sonic] SONIC timeline unavailable: ${err instanceof Error ? err.message : String(err)}`);
	}
	const durationS = fp?.durationS ?? p.analysis?.durationS ?? 0;
	const suggested = fp && plan ? suggestWindow(fp.events, durationS, plan.totalS, plan.firstMoveS, 1, 1) : { startS: 0, endS: durationS };
	const rv = raw.review ?? null;
	const wa = p.windowAnalysis ?? null;
	const reviewData = {
		durationS,
		envDb: fp?.envDb ?? [],
		frameS: FRAME_S,
		audioSrc: `/validation/sonic/${s._id}/audio`,
		spectroUrl: p.spectrogram?.fileId ? `/validation/sonic/${s._id}/spectrogram.png?v=${p.spectrogram.fileId}` : null,
		review: rv
			? {
					status: rv.status as 'verified' | 'unusable',
					startS: rv.startS ?? undefined,
					endS: rv.endS ?? undefined,
					reason: rv.reason ?? undefined,
					by: rv.by ?? undefined,
					at: rv.at ? new Date(rv.at).toISOString() : undefined
				}
			: null,
		suggested,
		planTotalS: plan?.totalS ?? 0,
		planSteps: plan?.steps ?? [],
		mappedSteps: wa?.steps ?? null,
		// Step placement (landmarks): the analysis' estimates, the times in use (estimates
		// + a saved, confirmed placement), loud stretches found, and real step durations.
		placement: wa?.landmarks
			? {
					estimates: wa.landmarks.estimates ?? [],
					used: wa.landmarks.used ?? [],
					segments: wa.landmarks.segments ?? [],
					durations: wa.durations ?? plan?.expected ?? [],
					confirmed: !!raw.stepPlacement?.confirmed,
					by: raw.stepPlacement?.by ?? null,
					at: raw.stepPlacement?.at ? new Date(raw.stepPlacement.at).toISOString() : null,
					measuredFrom: wa.measured?.from ?? 0
				}
			: null,
		anomalies: wa?.anomalies ?? [],
		windowSummary: wa
			? {
					at: wa.at ? new Date(wa.at).toISOString() : null,
					by: wa.by ?? null,
					alignment: { offsetS: wa.alignment?.offsetS, scale: wa.alignment?.scale, corr: wa.alignment?.corr, quality: wa.alignment?.quality },
					summary: wa.summary,
					referenceCount: wa.referenceSessionIds?.length ?? 0,
					window: wa.window
				}
			: null,
		mongoCopy: raw.mongoCopy ? { sha256: raw.mongoCopy.sha256 as string, size: raw.mongoCopy.size as number } : null
	};

	// Navigation between recordings (same list and order as /validation/sonic): a
	// light projection — no fingerprints or analysis bodies.
	const navRows = (await ValidationSession.find({ type: 'sonic', 'results.0.rawData.assay': { $in: ['SONIC', null] } })
		.select('spuUdi createdAt results.rawData.fileName results.rawData.review.status results.processedData.analysis.durationS results.processedData.analysis.error results.processedData.windowAnalysis.summary.total')
		.sort({ createdAt: -1 })
		.limit(300)
		.lean()) as any[];
	const nav = navRows.map((r) => {
		const rr = r.results?.[0] ?? {};
		const reviewStatus = rr.rawData?.review?.status as 'verified' | 'unusable' | undefined;
		const analyzed = rr.processedData?.analysis?.durationS != null && !rr.processedData?.analysis?.error;
		const status: 'verified' | 'unusable' | 'needs-trim' | 'needs-analysis' = reviewStatus ?? (analyzed ? 'needs-trim' : 'needs-analysis');
		return {
			id: r._id as string,
			udi: (r.spuUdi ?? '?') as string,
			at: r.createdAt ? new Date(r.createdAt).toISOString() : null,
			fileName: (rr.rawData?.fileName ?? null) as string | null,
			status,
			anomalies: (rr.processedData?.windowAnalysis?.summary?.total ?? null) as number | null
		};
	});

	// Other verified SONIC recordings, for "listen to the same moment on other SPUs":
	// only their placed step times (to map a moment across) and verified window.
	const cmpRows = (await ValidationSession.find({
		_id: { $ne: s._id },
		type: 'sonic',
		'results.0.rawData.assay': { $in: ['SONIC', null] },
		'results.0.rawData.review.status': 'verified',
		'results.0.processedData.windowAnalysis.steps.0': { $exists: true }
	})
		.select('spuUdi createdAt results.rawData.review.startS results.rawData.review.endS results.rawData.stepPlacement.confirmed results.processedData.reference.on results.processedData.windowAnalysis.steps')
		.sort({ createdAt: -1 })
		.limit(100)
		.lean()) as any[];
	const compare = cmpRows.map((r) => {
		const rr = r.results?.[0] ?? {};
		return {
			id: r._id as string,
			udi: (r.spuUdi ?? '?') as string,
			at: r.createdAt ? new Date(r.createdAt).toISOString() : null,
			audioSrc: `/validation/sonic/${r._id}/audio`,
			reference: !!rr.processedData?.reference?.on,
			confirmed: !!rr.rawData?.stepPlacement?.confirmed,
			startS: (rr.rawData?.review?.startS ?? null) as number | null,
			endS: (rr.rawData?.review?.endS ?? null) as number | null,
			steps: ((rr.processedData?.windowAnalysis?.steps ?? []) as any[]).map((x) => ({ index: x.index as number, t0: x.t0 as number, t1: x.t1 as number }))
		};
	});

	return {
		nav: JSON.parse(JSON.stringify(nav)),
		compare: JSON.parse(JSON.stringify(compare)),
		ignoreRules: await loadIgnoreRules(),
		review: JSON.parse(JSON.stringify(reviewData)),
		session: {
			id: s._id as string,
			spuId: (s.spuId ?? null) as string | null,
			spuUdi: (s.spuUdi ?? '?') as string,
			at: s.createdAt ? new Date(s.createdAt).toISOString() : null,
			recordedBy: user?.username ?? null,
			fileName: (raw.fileName ?? null) as string | null,
			size: (raw.size ?? null) as number | null,
			notes: (raw.notes ?? null) as string | null,
			assay: (raw.assay ?? null) as string | null,
			url: raw.r2Key ? await recordingUrl(raw.r2Key) : null,
			analysis: p.analysis ? JSON.parse(JSON.stringify(p.analysis)) : null,
			reference: !!p.reference?.on,
			storedVerdict: p.verdict ? JSON.parse(JSON.stringify(p.verdict)) : null
		},
		charts,
		live: fp ? await liveVerdict(s._id).catch((err) => {
			// The live score is a convenience; a compare failure must not take the page down.
			console.warn(`[sonic] live verdict for ${s._id} failed: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}) : null,
		tickS: TICK_S,
		minReferences: MIN_REFERENCES,
		passPct: PASS_INSIDE_PCT
	};
};
