import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, Spu } from '$lib/server/db';
import type { PageServerLoad } from './$types';

/**
 * SPU-vs-SPU magnetometer comparison.
 *
 * Reads the EXISTING `type: 'mag'` validation sessions (the 5-well / 3-channel
 * bench validation), NOT `type: 'mag_sweep'` — as of writing no sweep has ever
 * been ingested, so a sweep-backed comparison would render empty for every unit.
 *
 * magResults on a 'mag' session is an array of five rows:
 *   { well, chA_T, chA_X, chA_Y, chA_Z, chA_mag, chB_*, chC_* }
 * so each run carries 5 wells x 3 channels of full vector field data.
 */

const WELLS = [1, 2, 3, 4, 5] as const;
const CHANNELS = ['A', 'B', 'C'] as const;

type Channel = (typeof CHANNELS)[number];

/** Per (well, channel) accumulation across every run of one SPU. */
type Cell = {
	mag: number[];
	x: number[];
	y: number[];
	z: number[];
	t: number[];
};

type CellStat = {
	n: number;
	mag: number | null;
	magSd: number | null;
	x: number | null;
	y: number | null;
	z: number | null;
	t: number | null;
	/** Signed difference from the fleet median for this same well+channel. */
	delta: number | null;
	deltaPct: number | null;
};

type SpuRow = {
	spuId: string;
	udi: string;
	label: string;
	runs: number;
	lastRunAt: string | null;
	/** Mean |B| across every well+channel — the single-number fleet position. */
	overallMag: number | null;
	overallDelta: number | null;
	cells: Record<string, Record<string, CellStat>>;
};

const num = (v: unknown): number | null =>
	typeof v === 'number' && Number.isFinite(v) ? v : null;

const mean = (a: number[]): number | null =>
	a.length === 0 ? null : a.reduce((s, v) => s + v, 0) / a.length;

function sd(a: number[]): number | null {
	if (a.length < 2) return null;
	const m = mean(a);
	if (m === null) return null;
	const v = a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1);
	return Math.sqrt(v);
}

function median(a: number[]): number | null {
	if (a.length === 0) return null;
	const s = [...a].sort((p, q) => p - q);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round = (v: number | null, dp = 1): number | null =>
	v === null ? null : Number(v.toFixed(dp));

/** "BT-M01-0000-0255" -> "255"; falls back to the raw udi when it doesn't match. */
function shortLabel(udi: string | undefined | null): string {
	if (!udi) return '(no udi)';
	const m = /(\d+)\s*$/.exec(udi);
	return m ? String(Number(m[1])) : udi;
}

const cellKey = (well: number, ch: Channel) => `${well}|${ch}`;

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const sessions = (await ValidationSession.find(
		{ type: 'mag', magResults: { $exists: true } },
		{ spuId: 1, magResults: 1, createdAt: 1, overallPassed: 1 }
	)
		.sort({ createdAt: -1 })
		.lean()) as any[];

	// spuId -> "well|channel" -> samples
	const bySpu = new Map<string, Map<string, Cell>>();
	const runCount = new Map<string, number>();
	const lastRun = new Map<string, string>();

	for (const s of sessions) {
		const spuId = typeof s.spuId === 'string' ? s.spuId : null;
		if (!spuId || !Array.isArray(s.magResults)) continue;

		runCount.set(spuId, (runCount.get(spuId) ?? 0) + 1);
		const at = s.createdAt instanceof Date ? s.createdAt.toISOString() : String(s.createdAt ?? '');
		if (at && !lastRun.has(spuId)) lastRun.set(spuId, at); // sorted desc, first wins

		let cells = bySpu.get(spuId);
		if (!cells) {
			cells = new Map<string, Cell>();
			bySpu.set(spuId, cells);
		}

		for (const row of s.magResults) {
			const well = num(row?.well);
			if (well === null || !WELLS.includes(well as (typeof WELLS)[number])) continue;

			for (const ch of CHANNELS) {
				const x = num(row[`ch${ch}_X`]);
				const y = num(row[`ch${ch}_Y`]);
				const z = num(row[`ch${ch}_Z`]);
				const t = num(row[`ch${ch}_T`]);

				// |B| is DERIVED, not read. A stored `ch*_mag` is present on only 20 of
				// 3515 rows (0.6%), while X/Y/Z are present on all of them. Where both
				// exist the two agree to <1e-12, so the derivation is authoritative and
				// it is what makes the other 36 SPUs render at all.
				const stored = num(row[`ch${ch}_mag`]);
				const mag = x !== null && y !== null && z !== null ? Math.hypot(x, y, z) : stored;

				if (mag === null && x === null && y === null && z === null) continue;

				const k = cellKey(well, ch);
				let cell = cells.get(k);
				if (!cell) {
					cell = { mag: [], x: [], y: [], z: [], t: [] };
					cells.set(k, cell);
				}
				if (mag !== null) cell.mag.push(mag);
				if (x !== null) cell.x.push(x);
				if (y !== null) cell.y.push(y);
				if (z !== null) cell.z.push(z);
				if (t !== null) cell.t.push(t);
			}
		}
	}

	// Fleet median per well+channel, computed over PER-SPU MEANS so a unit with
	// 104 runs does not outweigh one with 17.
	const perSpuMeans = new Map<string, number[]>();
	for (const cells of bySpu.values()) {
		for (const [k, cell] of cells) {
			const m = mean(cell.mag);
			if (m === null) continue;
			const arr = perSpuMeans.get(k) ?? [];
			arr.push(m);
			perSpuMeans.set(k, arr);
		}
	}
	const fleetMedian = new Map<string, number | null>();
	for (const [k, arr] of perSpuMeans) fleetMedian.set(k, median(arr));

	const spuDocs = (await Spu.find(
		{ _id: { $in: [...bySpu.keys()] } },
		{ udi: 1, status: 1 }
	).lean()) as any[];
	const udiById = new Map<string, string>(spuDocs.map((d) => [String(d._id), String(d.udi ?? '')]));

	const rows: SpuRow[] = [];
	for (const [spuId, cells] of bySpu) {
		const out: Record<string, Record<string, CellStat>> = {};
		const allMeans: number[] = [];
		const allDeltas: number[] = [];

		for (const well of WELLS) {
			const perCh: Record<string, CellStat> = {};
			for (const ch of CHANNELS) {
				const cell = cells.get(cellKey(well, ch));
				const m = cell ? mean(cell.mag) : null;
				const fm = fleetMedian.get(cellKey(well, ch)) ?? null;
				const delta = m !== null && fm !== null ? m - fm : null;
				if (m !== null) allMeans.push(m);
				if (delta !== null) allDeltas.push(delta);

				perCh[ch] = {
					n: cell ? cell.mag.length : 0,
					mag: round(m, 1),
					magSd: round(cell ? sd(cell.mag) : null, 1),
					x: round(cell ? mean(cell.x) : null, 1),
					y: round(cell ? mean(cell.y) : null, 1),
					z: round(cell ? mean(cell.z) : null, 1),
					t: round(cell ? mean(cell.t) : null, 1),
					delta: round(delta, 1),
					deltaPct: delta !== null && fm ? Number(((delta / fm) * 100).toFixed(2)) : null
				};
			}
			out[String(well)] = perCh;
		}

		const udi = udiById.get(spuId) ?? '';
		rows.push({
			spuId,
			udi,
			label: shortLabel(udi),
			runs: runCount.get(spuId) ?? 0,
			lastRunAt: lastRun.get(spuId) ?? null,
			overallMag: round(mean(allMeans), 1),
			overallDelta: round(mean(allDeltas), 1),
			cells: out
		});
	}

	// Biggest absolute fleet deviation first — the "which unit is odd" ordering.
	rows.sort((a, b) => Math.abs(b.overallDelta ?? 0) - Math.abs(a.overallDelta ?? 0));

	// Focus defaults to SPU 255 (the bench unit) when present, else the most deviant.
	const requested = url.searchParams.get('spu');
	const focus =
		rows.find((r) => r.spuId === requested || r.label === requested || r.udi === requested) ??
		rows.find((r) => r.label === '255') ??
		rows[0] ??
		null;

	const fleet: Record<string, Record<string, number | null>> = {};
	for (const well of WELLS) {
		const perCh: Record<string, number | null> = {};
		for (const ch of CHANNELS) perCh[ch] = round(fleetMedian.get(cellKey(well, ch)) ?? null, 1);
		fleet[String(well)] = perCh;
	}

	return JSON.parse(
		JSON.stringify({
			wells: WELLS,
			channels: CHANNELS,
			fleet,
			focus,
			rows,
			totals: { spus: rows.length, runs: sessions.length }
		})
	);
};
