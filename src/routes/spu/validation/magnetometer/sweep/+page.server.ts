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
 */

// Field offsets within a stored row: [0]=y(microns) [1]=well [2]=rep then (t,x,y,z) per channel.
const ROW_Y = 0;
const ROW_WELL = 1;
const CHANNELS = [
	{ ch: 'A', t: 3, x: 4, y: 5, z: 6 },
	{ ch: 'B', t: 7, x: 8, y: 9, z: 10 },
	{ ch: 'C', t: 11, x: 12, y: 13, z: 14 }
] as const;

const SESSION_LIST_LIMIT = 50;

type SeriesPoint = { y: number; bx: number; by: number; bz: number; mag: number };
type SeriesByWell = Record<string, Record<string, SeriesPoint[]>>;

/**
 * Mirrors the ingest endpoint's aggregation: group by (well, channel) then by
 * stage position, MEAN each component over the reps sharing that position, and
 * derive |B| from the averaged components (not by averaging magnitudes).
 */
function buildSeries(rawRows: unknown): SeriesByWell {
	const out: SeriesByWell = {};
	if (!Array.isArray(rawRows)) return out;

	// "well|channel" -> stage y -> running component sums
	const acc = new Map<string, Map<number, { bx: number; by: number; bz: number; n: number }>>();

	for (const row of rawRows as unknown[]) {
		if (!Array.isArray(row)) continue;
		const r = row as number[];

		const y = Number(r[ROW_Y]);
		const well = Number(r[ROW_WELL]);
		if (!Number.isFinite(y) || !Number.isFinite(well)) continue;

		for (const c of CHANNELS) {
			const bx = Number(r[c.x]);
			const by = Number(r[c.y]);
			const bz = Number(r[c.z]);
			if (!Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz)) continue;

			const key = `${well}|${c.ch}`;
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
					wells: mag.wells ?? {},
					wellNumbers: mag.wellNumbers ?? [],
					channels: mag.channels ?? [],
					rowsIngested: mag.rowsIngested ?? null,
					rowsReported: mag.rowsReported ?? null,
					goodReported: mag.goodReported ?? null,
					durationMs: mag.durationMs ?? null
				}
			: null,
		series: buildSeries(full.rawData?.rows)
	}));
};
