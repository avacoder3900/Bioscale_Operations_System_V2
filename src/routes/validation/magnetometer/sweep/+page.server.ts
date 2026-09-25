import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession } from '$lib/server/db';
import type { PageServerLoad } from './$types';

/**
 * Sweep viewer. Sweeps land as ValidationSession documents with a top-level
 * `type: 'mag_sweep'` ('magnetometer_sweep' is only the nested results[0].testType,
 * so matching on that would find nothing here).
 *
 * magResults holds the per-well/per-channel PROFILE SUMMARY only — its `points`
 * field is a count, not an array — so the plottable series has to be re-derived
 * from the verbatim rawData capture. That aggregation is duplicated below rather
 * than imported: the ingest endpoint is owned elsewhere and this page must not
 * drag a route handler into its import graph.
 *
 * Row layout is NOT fixed. `rawData.format` discriminates between at least two
 * shapes today:
 *   'spu-mag-sweep/v1'       — bench pusher, per-rep raw rows
 *   'spu-mag-sweep-means/v1' — firmware v98 device upload, per-position means + SD
 * `rawData.fields[]` is always present in every format and is the authoritative,
 * ordered column-header list, so columns are resolved BY NAME from it rather than
 * by hardcoded offset — that's what makes this format-agnostic instead of tied to
 * whichever layout happened to exist first. `magResults.wells[well][channel]` is
 * unchanged across formats.
 */

const SESSION_LIST_LIMIT = 50;

type SeriesPoint = { y: number; bx: number; by: number; bz: number; mag: number };
type SeriesByWell = Record<string, Record<string, SeriesPoint[]>>;

interface RawSweepData {
	format?: unknown;
	fields?: unknown;
	rows?: unknown;
}

type ChannelCols = { x: number; y: number; z: number };

/**
 * Resolve the stage-position column, the well column, and per-channel x/y/z
 * field-component columns from `fields[]` by exact name match — known names
 * today are 'y', 'well', and `x${ch}`/`y${ch}`/`z${ch}` per channel (see the
 * ingest endpoint's own `fields` array for 'spu-mag-sweep/v1'). Any column
 * that can't be found is left unresolved rather than guessed at; callers must
 * drop what they can't resolve instead of falling back to a positional offset.
 */
function resolveColumns(
	fields: unknown,
	channels: string[]
): { yIdx: number; wellIdx: number; perChannel: Map<string, ChannelCols> } | null {
	if (!Array.isArray(fields)) return null;

	const indexOf = (name: string): number => (fields as unknown[]).indexOf(name);

	const yIdx = indexOf('y');
	const wellIdx = indexOf('well');
	if (yIdx < 0 || wellIdx < 0) return null;

	const perChannel = new Map<string, ChannelCols>();
	for (const ch of channels) {
		const x = indexOf(`x${ch}`);
		const y = indexOf(`y${ch}`);
		const z = indexOf(`z${ch}`);
		// Degrade honestly: a channel missing any of its three components is
		// dropped, not reconstructed from a guessed offset.
		if (x < 0 || y < 0 || z < 0) continue;
		perChannel.set(ch, { x, y, z });
	}

	return { yIdx, wellIdx, perChannel };
}

/**
 * Mirrors the ingest endpoint's aggregation: group by (well, channel) then by
 * stage position, MEAN each component over the rows sharing that position, and
 * derive |B| from the averaged components (not by averaging magnitudes). This
 * is format-agnostic: for per-rep rows the mean is over reps; for per-position
 * rows (already one row per position) it's a no-op mean of one.
 */
function buildSeries(rawData: RawSweepData | null | undefined, channels: string[]): SeriesByWell {
	const out: SeriesByWell = {};
	const rows = rawData?.rows;
	if (!Array.isArray(rows)) return out;

	const cols = resolveColumns(rawData?.fields, channels);
	if (!cols) return out;

	// "well|channel" -> stage y -> running component sums
	const acc = new Map<string, Map<number, { bx: number; by: number; bz: number; n: number }>>();

	for (const row of rows as unknown[]) {
		if (!Array.isArray(row)) continue;
		const r = row as number[];

		const y = Number(r[cols.yIdx]);
		const well = Number(r[cols.wellIdx]);
		if (!Number.isFinite(y) || !Number.isFinite(well)) continue;

		for (const [ch, idx] of cols.perChannel) {
			const bx = Number(r[idx.x]);
			const by = Number(r[idx.y]);
			const bz = Number(r[idx.z]);
			if (!Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz)) continue;

			const key = `${well}|${ch}`;
			let byPos = acc.get(key);
			if (!byPos) {
				byPos = new Map();
				acc.set(key, byPos);
			}

			const cur = byPos.get(y) ?? { bx: 0, by: 0, bz: 0, n: 0 };
			cur.bx += bx;
			cur.by += by;
			cur.bz += bz;
			cur.n += 1;
			byPos.set(y, cur);
		}
	}

	for (const [key, byPos] of acc) {
		const [well, ch] = key.split('|');
		const points: SeriesPoint[] = [...byPos.entries()]
			.map(([y, s]) => {
				const bx = s.bx / s.n;
				const by = s.by / s.n;
				const bz = s.bz / s.n;
				return { y, bx, by, bz, mag: Math.sqrt(bx * bx + by * by + bz * bz) };
			})
			.sort((a, b) => a.y - b.y);

		(out[well] ??= {})[ch] = points;
	}

	return out;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// Lightweight picker list.
	const sessions = await ValidationSession.find(
		{ type: 'mag_sweep' },
		{
			spuId: 1,
			spuUdi: 1,
			status: 1,
			startedAt: 1,
			completedAt: 1,
			createdAt: 1,
			'magResults.wellNumbers': 1,
			'magResults.rowsIngested': 1
		}
	)
		.sort({ startedAt: -1, createdAt: -1 })
		.limit(SESSION_LIST_LIMIT)
		.lean() as any[];

	const empty = {
		sessions: [] as any[],
		selected: null,
		magResults: null,
		series: {} as SeriesByWell
	};

	if (sessions.length === 0) return empty;

	// ?sessionId= selects one; anything unresolvable silently falls back to the newest.
	const requestedId = url.searchParams.get('sessionId');
	let selectedId: string = sessions[0]._id;

	if (requestedId) {
		if (sessions.some((s: any) => s._id === requestedId)) {
			selectedId = requestedId;
		} else {
			// May be a valid sweep that simply fell outside the recent-list window.
			const hit = await ValidationSession.findOne(
				{ _id: requestedId, type: 'mag_sweep' },
				{ _id: 1 }
			).lean() as any;
			if (hit) selectedId = hit._id;
		}
	}

	const full = await ValidationSession.findOne(
		{ _id: selectedId },
		{
			spuId: 1,
			spuUdi: 1,
			status: 1,
			startedAt: 1,
			completedAt: 1,
			magResults: 1,
			'rawData.format': 1,
			'rawData.fields': 1,
			'rawData.rows': 1
		}
	).lean() as any;

	if (!full) {
		return { ...empty, sessions: JSON.parse(JSON.stringify(sessions)) };
	}

	const mag = full.magResults ?? null;

	// rawData.rows is dropped from the payload on purpose — up to 20000 raw rows
	// would dwarf the derived series the page actually plots.
	return JSON.parse(JSON.stringify({
		sessions,
		selected: {
			_id: full._id,
			spuId: full.spuId ?? null,
			spuUdi: full.spuUdi ?? null,
			status: full.status ?? null,
			startedAt: full.startedAt ?? null,
			completedAt: full.completedAt ?? null
		},
		magResults: mag
			? {
					wells: flagUnreliablePeaks(mag.wells, deriveCoverage(mag).coverageComplete),
					wellNumbers: mag.wellNumbers ?? [],
					channels: mag.channels ?? [],
					rowsIngested: mag.rowsIngested ?? null,
					rowsReported: mag.rowsReported ?? null,
					goodReported: mag.goodReported ?? null,
					// Coverage, so the page can refuse to present a peak computed from
					// a run that lost rows. DERIVED ON READ when absent: sessions
					// ingested before these fields existed still stored rowsReported
					// and rowsIngested, which is everything the comparison needs. That
					// matters - the run that exposed this problem (SPU 239, BLE died at
					// y=34000) was ingested before the fix and would otherwise render
					// as if nothing were wrong. Nothing historical is rewritten.
					...deriveCoverage(mag),
					durationMs: mag.durationMs ?? null
				}
			: null,
		series: buildSeries(full.rawData, mag?.channels ?? [])
	}));
};

/**
 * Coverage for a stored sweep, preferring what was written at ingest and falling
 * back to a derivation for older sessions.
 *
 * A read the magnetometer never answered is written NOCHAR by the firmware, has no
 * numeric fields, and is dropped before storage - so it is ABSENT, not zero. An
 * incomplete run therefore looks exactly like a complete, shorter one unless the
 * device's own declared total is compared against what actually landed.
 *
 * Returns coverageComplete: null when the device never declared a total. Null is
 * UNKNOWN and must not be rendered as an all-clear.
 */
function deriveCoverage(mag: any): {
	rowsMissing: number | null;
	coverage: number | null;
	coverageComplete: boolean | null;
} {
	if (typeof mag?.coverageComplete === 'boolean') {
		return {
			rowsMissing: mag.rowsMissing ?? null,
			coverage: mag.coverage ?? null,
			coverageComplete: mag.coverageComplete
		};
	}
	const reported = typeof mag?.rowsReported === 'number' ? mag.rowsReported : null;
	const ingested = typeof mag?.rowsIngested === 'number' ? mag.rowsIngested : null;
	if (reported === null || ingested === null) {
		return { rowsMissing: null, coverage: null, coverageComplete: null };
	}
	const rowsMissing = Math.max(0, reported - ingested);
	return {
		rowsMissing,
		coverage: reported > 0 ? ingested / reported : null,
		coverageComplete: rowsMissing === 0
	};
}

/**
 * Mark peaks that sit on the edge of the data that SURVIVED, for sessions stored
 * before the flag existed. Same rule as the ingest: only meaningful once the run is
 * known to have lost rows, because in a complete sweep an edge peak is a different
 * (and milder) problem - a window that missed the magnet, not a link that died.
 */
function flagUnreliablePeaks(wells: any, coverageComplete: boolean | null): any {
	if (coverageComplete !== false || !wells || typeof wells !== 'object') return wells ?? {};
	const out: Record<string, Record<string, unknown>> = {};
	for (const [well, chs] of Object.entries(wells as Record<string, any>)) {
		out[well] = {};
		for (const [ch, p] of Object.entries((chs ?? {}) as Record<string, any>)) {
			out[well][ch] =
				p && typeof p === 'object' && p.peakUnreliable === undefined
					? { ...p, peakUnreliable: !!p.peakAtWindowEdge }
					: p;
		}
	}
	return out;
}
