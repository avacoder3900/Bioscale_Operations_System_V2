import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, ValidationSession, Spu, AuditLog, generateId } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * Magnetometer stage-sweep ingest.
 *
 * The SPU streams sweep rows over serial (command 77), which never touches the
 * cloud. A bench-side pusher parses the SWPBEGIN/S/SWPEND text and POSTs it
 * here so the run lands in Mongo alongside normal validation sessions.
 *
 * Raw rows are stored verbatim for provenance; per-well/channel field summaries
 * are derived server-side so every consumer sees identical numbers.
 */

// Field offsets within a row AFTER the leading "S" tag is stripped:
// [0]=y(microns) [1]=well [2]=rep then (t,x,y,z) per channel.
const ROW_Y = 0;
const ROW_WELL = 1;
const ROW_REP = 2;
const CHANNELS = [
	{ ch: 'A', t: 3, x: 4, y: 5, z: 6 },
	{ ch: 'B', t: 7, x: 8, y: 9, z: 10 },
	{ ch: 'C', t: 11, x: 12, y: 13, z: 14 }
] as const;
const ROW_FIELDS = 15;

const MAX_ROWS = 20000;

type Agg = { y: number; bx: number; by: number; bz: number; t: number; mag: number; reps: number };

/** Mean each component over reps at a given stage position, then derive |B|. */
function aggregate(rows: number[][]): Map<string, Agg[]> {
	const acc = new Map<string, Map<number, { bx: number; by: number; bz: number; t: number; n: number }>>();

	for (const r of rows) {
		const y = r[ROW_Y];
		const well = r[ROW_WELL];
		if (!Number.isFinite(y) || !Number.isFinite(well)) continue;

		for (const c of CHANNELS) {
			const bx = r[c.x], by = r[c.y], bz = r[c.z], t = r[c.t];
			if (![bx, by, bz].every(Number.isFinite)) continue;

			const key = `${well}|${c.ch}`;
			let byPos = acc.get(key);
			if (!byPos) { byPos = new Map(); acc.set(key, byPos); }

			const cur = byPos.get(y) ?? { bx: 0, by: 0, bz: 0, t: 0, n: 0 };
			cur.bx += bx; cur.by += by; cur.bz += bz;
			cur.t += Number.isFinite(t) ? t : 0;
			cur.n += 1;
			byPos.set(y, cur);
		}
	}

	const out = new Map<string, Agg[]>();
	for (const [key, byPos] of acc) {
		const series = [...byPos.entries()]
			.map(([y, s]) => {
				const bx = s.bx / s.n, by = s.by / s.n, bz = s.bz / s.n;
				return { y, bx, by, bz, t: s.t / s.n, mag: Math.sqrt(bx * bx + by * by + bz * bz), reps: s.n };
			})
			.sort((a, b) => a.y - b.y);
		out.set(key, series);
	}
	return out;
}

/** Peak position, amplitude and full-width-half-max of the |B| profile. */
function profile(series: Agg[]) {
	if (series.length === 0) return null;

	let peak = series[0];
	for (const p of series) if (p.mag > peak.mag) peak = p;

	const baseline = Math.min(...series.map((p) => p.mag));
	const half = baseline + (peak.mag - baseline) / 2;
	const peakIdx = series.indexOf(peak);

	// Walk outward from the peak to the first half-max crossing on each side and
	// linearly interpolate. Null when the sweep window clipped the shoulder.
	const cross = (dir: -1 | 1): number | null => {
		for (let i = peakIdx; i >= 0 && i < series.length; i += dir) {
			const next = i + dir;
			if (next < 0 || next >= series.length) return null;
			if (series[next].mag <= half) {
				const a = series[i], b = series[next];
				const span = a.mag - b.mag;
				if (span === 0) return b.y;
				return a.y + ((a.mag - half) / span) * (b.y - a.y);
			}
		}
		return null;
	};

	const left = cross(-1), right = cross(1);

	// Well 5 crests beyond STAGE_POSITION_LIMIT, so the stage runs out of travel
	// while |B| is still climbing. That is a travel-limited well — not a failed
	// one and not truncated data — so characterise it by the slope of its rising
	// tail instead of a peak the stage physically cannot reach.
	const lastIdx = series.length - 1;
	const distal = peakIdx >= lastIdx && right === null;
	const proximal = !distal && peakIdx <= 0 && left === null;
	const travelLimited = distal || proximal;
	const edge: 'none' | 'distal' | 'proximal' = distal ? 'distal' : proximal ? 'proximal' : 'none';

	// Least-squares fit of |B| against y over the rising tail leading to that edge.
	const fitRisingTail = () => {
		const tailCount = Math.max(3, Math.ceil(series.length * 0.3));
		const lo = left, hi = right;
		let seg: Agg[];
		if (distal) {
			seg = lo !== null ? series.filter((p, i) => i <= peakIdx && p.y >= lo) : [];
			if (seg.length < 3) seg = series.slice(Math.max(0, series.length - tailCount));
		} else {
			seg = hi !== null ? series.filter((p, i) => i >= peakIdx && p.y <= hi) : [];
			if (seg.length < 3) seg = series.slice(0, tailCount);
		}
		if (seg.length < 2) return null;

		const n = seg.length;
		const meanY = seg.reduce((a, p) => a + p.y, 0) / n;
		const meanMag = seg.reduce((a, p) => a + p.mag, 0) / n;
		let sxx = 0, sxy = 0, syy = 0;
		for (const p of seg) {
			const dy = p.y - meanY, dm = p.mag - meanMag;
			sxx += dy * dy;
			sxy += dy * dm;
			syy += dm * dm;
		}
		if (!(sxx > 0)) return null;

		const slope = sxy / sxx;
		if (!Number.isFinite(slope)) return null;
		const rawR2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : NaN;

		return {
			// |B| units per 1000 microns (per mm of stage travel).
			slopePerMm: Number((slope * 1000).toFixed(3)),
			slopeR2: Number.isFinite(rawR2) ? Number(Math.min(1, Math.max(0, rawR2)).toFixed(4)) : null,
			slopeSpanY: [seg[0].y, seg[n - 1].y] as [number, number]
		};
	};

	const fit = travelLimited ? fitRisingTail() : null;

	return {
		peakY: peak.y,
		peakMag: Number(peak.mag.toFixed(3)),
		peakBx: Number(peak.bx.toFixed(3)),
		peakBy: Number(peak.by.toFixed(3)),
		peakBz: Number(peak.bz.toFixed(3)),
		baseline: Number(baseline.toFixed(3)),
		amplitude: Number((peak.mag - baseline).toFixed(3)),
		fwhm: left !== null && right !== null ? Number((right - left).toFixed(1)) : null,
		halfMaxLeftY: left !== null ? Number(left.toFixed(1)) : null,
		halfMaxRightY: right !== null ? Number(right.toFixed(1)) : null,
		clipped: left === null || right === null,
		points: series.length,
		yMin: series[0].y,
		yMax: series[series.length - 1].y,
		travelLimited,
		edge,
		slopePerMm: fit ? fit.slopePerMm : null,
		slopeR2: fit ? fit.slopeR2 : null,
		slopeSpanY: fit ? fit.slopeSpanY : null,
		method: travelLimited ? ('slope' as const) : ('peak' as const)
	};
}

/**
 * Resolve an SPU from a human-supplied token without trusting a recalled id:
 * exact _id / udi / barcode first, then a unique udi suffix match. Ambiguous
 * tokens are rejected rather than silently picking one.
 */
async function resolveSpu(token: string) {
	const exact = await Spu.findOne({
		$or: [{ _id: token }, { udi: token }, { barcode: token }]
	}).lean() as any;
	if (exact) return exact;

	const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const matches = await Spu.find({ udi: { $regex: `${escaped}$` } }, { udi: 1 })
		.limit(5).lean() as any[];

	if (matches.length === 1) return await Spu.findById(matches[0]._id).lean() as any;
	if (matches.length > 1) {
		throw error(409, `Ambiguous SPU "${token}" — matches ${matches.map((m) => m.udi).join(', ')}`);
	}
	throw error(404, `No SPU matches "${token}"`);
}

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { spu, meta, end, rows, sourceFile, particleDeviceId, notes } = body ?? {};

	if (!spu || typeof spu !== 'string') {
		return json({ success: false, error: 'spu (udi, barcode, _id or udi suffix) is required' }, { status: 400 });
	}
	if (!Array.isArray(rows) || rows.length === 0) {
		return json({ success: false, error: 'rows[] is required and must be non-empty' }, { status: 400 });
	}
	if (rows.length > MAX_ROWS) {
		return json({ success: false, error: `rows[] exceeds ${MAX_ROWS}` }, { status: 413 });
	}

	const clean: number[][] = [];
	for (const r of rows) {
		if (!Array.isArray(r) || r.length < ROW_FIELDS) continue;
		clean.push(r.slice(0, ROW_FIELDS).map(Number));
	}
	if (clean.length === 0) {
		return json({ success: false, error: `no row had ${ROW_FIELDS} numeric fields` }, { status: 400 });
	}

	const target = await resolveSpu(spu);

	const series = aggregate(clean);
	const wells: Record<string, unknown> = {};
	for (const [key, s] of series) {
		const [well, ch] = key.split('|');
		const p = profile(s);
		if (!p) continue;
		((wells[well] ??= {}) as Record<string, unknown>)[ch] = p;
	}

	const wellNumbers = [...new Set(clean.map((r) => r[ROW_WELL]))].sort((a, b) => a - b);
	const startedAt = new Date();

	const session = await ValidationSession.create({
		_id: generateId(),
		type: 'mag_sweep',
		spuId: target._id,
		spuUdi: target.udi,
		particleDeviceId: particleDeviceId || target?.particleLink?.particleDeviceId || undefined,
		status: 'completed',
		startedAt,
		completedAt: new Date(),
		userId: 'agent-api',
		// Verbatim capture: the firmware's own header/footer and every raw row.
		rawData: {
			format: 'spu-mag-sweep/v1',
			meta: meta ?? null,
			end: end ?? null,
			sourceFile: sourceFile ?? null,
			fields: ['y', 'well', 'rep', 'tA', 'xA', 'yA', 'zA', 'tB', 'xB', 'yB', 'zB', 'tC', 'xC', 'yC', 'zC'],
			rows: clean
		},
		magResults: {
			wells,
			wellNumbers,
			channels: CHANNELS.map((c) => c.ch),
			rowsIngested: clean.length,
			rowsReported: end?.rows ?? null,
			goodReported: end?.good ?? null,
			durationMs: end?.ms ?? null
		},
		// A sweep is a characterisation run, not a pass/fail gate.
		overallPassed: undefined,
		failureReasons: [],
		results: [{
			_id: generateId(),
			testType: 'magnetometer_sweep',
			processedData: { wells, wellNumbers },
			notes: notes || undefined,
			createdAt: new Date()
		}]
	});

	// Immutable audit entry only after the session write succeeds.
	await AuditLog.create({
		_id: generateId(),
		tableName: 'validation_sessions',
		recordId: session._id,
		action: 'INSERT',
		newData: {
			type: 'mag_sweep',
			spuId: target._id,
			spuUdi: target.udi,
			rows: clean.length,
			wells: wellNumbers,
			sourceFile: sourceFile ?? null
		},
		changedAt: new Date(),
		changedBy: 'agent-api'
	});

	return json({
		success: true,
		data: {
			sessionId: session._id,
			spuId: target._id,
			spuUdi: target.udi,
			rowsIngested: clean.length,
			wells: wellNumbers,
			summary: wells
		}
	}, { status: 201 });
};

export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const sessionId = url.searchParams.get('sessionId');

	if (sessionId) {
		const session = await ValidationSession.findById(sessionId).lean() as any;
		if (!session || session.type !== 'mag_sweep') throw error(404, 'Sweep session not found');

		// Raw rows are large; only ship them when explicitly asked for.
		if (url.searchParams.get('raw') !== 'true' && session.rawData) {
			session.rawData = { ...session.rawData, rows: undefined, rowCount: session.rawData.rows?.length ?? 0 };
		}
		return json({ success: true, data: session });
	}

	const filter: Record<string, unknown> = { type: 'mag_sweep' };
	const spuToken = url.searchParams.get('spu');
	if (spuToken) filter.spuId = (await resolveSpu(spuToken))._id;

	const limit = Math.min(parseInt(url.searchParams.get('limit') || '25'), 100);
	const sessions = await ValidationSession.find(filter, {
		spuId: 1, spuUdi: 1, status: 1, startedAt: 1, completedAt: 1, magResults: 1, createdAt: 1
	}).sort({ createdAt: -1 }).limit(limit).lean() as any[];

	return json({ success: true, data: { sessions, count: sessions.length } });
};
