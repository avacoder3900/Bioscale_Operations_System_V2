import { OpticalBlankRun, ValidationSession } from '$lib/server/db';
import { gradeBenchUnit, gradeBlankRun, type Graded } from './validation-autograde';

export interface UnitAutoVerdicts {
	/** Latest blank run, graded. null = the unit has never run the blank. */
	blank: (Graded & { at: string | null; runId: string }) | null;
	/** Latest laser + dark bench reads, graded together. null = no bench read at all. */
	bench: (Graded & { at: string | null }) | null;
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/**
 * Bench + blank verdicts for a set of units, from each unit's LATEST runs.
 * Two aggregations total, whatever the number of units — the fleet pages call
 * this once, not per row.
 */
export async function loadAutoVerdicts(spus: { _id: string; udi?: string | null }[]): Promise<Map<string, UnitAutoVerdicts>> {
	const ids = spus.map((s) => s._id);
	const udis = spus.map((s) => s.udi).filter((u): u is string => !!u);
	const [blankAgg, benchAgg] = await Promise.all([
		// Older blank rows carry only spuUdi (written before spuId was resolved), so match either.
		OpticalBlankRun.aggregate([
			{ $match: { $or: [{ spuId: { $in: ids } }, { spuUdi: { $in: udis } }] } },
			{ $sort: { receivedAt: -1 } },
			{
				$facet: {
					byId: [{ $group: { _id: '$spuId', run: { $first: '$$ROOT' } } }],
					byUdi: [{ $group: { _id: '$spuUdi', run: { $first: '$$ROOT' } } }]
				}
			}
		]),
		ValidationSession.aggregate([
			{ $match: { type: { $in: ['laser', 'dark'] }, spuId: { $in: ids } } },
			{ $sort: { startedAt: -1, createdAt: -1 } },
			{
				$group: {
					_id: { spuId: '$spuId', type: '$type' },
					rawData: { $first: '$rawData' },
					at: { $first: { $ifNull: ['$startedAt', '$createdAt'] } }
				}
			}
		])
	]);

	const blankById = new Map<string, any>();
	const blankByUdi = new Map<string, any>();
	for (const r of ((blankAgg as any[])[0]?.byId ?? []) as any[]) if (r._id) blankById.set(String(r._id), r.run);
	for (const r of ((blankAgg as any[])[0]?.byUdi ?? []) as any[]) if (r._id) blankByUdi.set(String(r._id), r.run);

	const bench = new Map<string, { laser?: { result: unknown; at: string | null }; dark?: { result: unknown; at: string | null } }>();
	for (const r of benchAgg as any[]) {
		const id = String(r._id?.spuId ?? '');
		const entry = bench.get(id) ?? {};
		entry[r._id.type as 'laser' | 'dark'] = { result: r.rawData ?? null, at: iso(r.at) };
		bench.set(id, entry);
	}

	const out = new Map<string, UnitAutoVerdicts>();
	for (const s of spus) {
		const a = blankById.get(s._id);
		const b = s.udi ? blankByUdi.get(s.udi) : null;
		const run = !a ? b : !b ? a : new Date(a.receivedAt ?? 0) >= new Date(b.receivedAt ?? 0) ? a : b;
		const reads = bench.get(s._id);
		out.set(s._id, {
			blank: run
				? { ...gradeBlankRun(run.readings, run.numberOfReadings), at: iso(run.receivedAt ?? run.publishedAt), runId: String(run._id) }
				: null,
			bench:
				reads && (reads.laser || reads.dark)
					? { ...gradeBenchUnit(reads.laser, reads.dark), at: later(reads.laser?.at ?? null, reads.dark?.at ?? null) }
					: null
		});
	}
	return out;
}
