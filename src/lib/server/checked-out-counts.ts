/**
 * Dashboard counts that exclude manually checked-out cartridges, without `$nin`.
 *
 * `_id: { $nin: checkedOutIds }` defeats every cartridge_records index: each count
 * FETCHed all ~18,600 documents (~660 MB through a 512 MB cache), evicting what the
 * research and consumer apps had cached. ManualCartridgeRemoval is append-only, so
 *
 *   count(P ∧ _id ∉ S)  ≡  count(P) − count(P ∧ _id ∈ S)
 *
 * for every predicate P. Each spec runs once over its own index, and all specs run
 * once more over the ~80 checked-out ids (one aggregation, `$facet`), then subtract.
 * Two reads are not one snapshot: a cart changed between them can be off by one for
 * that load, the same race the parallel `$nin` queries already had.
 */

import type { PipelineStage } from 'mongoose';

export interface GroupSpec {
	match: Record<string, unknown>;
	/** A `$group` stage body. Every accumulator other than `_id` must be a `$sum`. */
	group: Record<string, unknown> & { _id: unknown };
	sort?: Record<string, 1 | -1>;
}

export interface GroupRow {
	_id: unknown;
	[field: string]: unknown;
}

/** Anything with an aggregate: a Mongoose model, or a driver collection wrapped with `.toArray()`. */
export interface Aggregator {
	aggregate(pipeline: PipelineStage[]): PromiseLike<unknown[]>;
}

const stages = ({ match, group }: GroupSpec): PipelineStage[] => [{ $match: match }, { $group: group } as PipelineStage.Group];

const keyOf = (id: unknown) => JSON.stringify(id ?? null);

/** `totals` minus `excluded`, field by field; groups that drop to zero disappear, as they would under `$nin`. */
export function subtractRows(totals: GroupRow[], excluded: GroupRow[], countField = 'count'): GroupRow[] {
	const byKey = new Map(excluded.map((row) => [keyOf(row._id), row]));
	return totals
		.map((row) => {
			const minus = byKey.get(keyOf(row._id));
			if (!minus) return row;
			const out: GroupRow = { ...row };
			for (const [field, value] of Object.entries(row)) {
				if (field !== '_id' && typeof value === 'number') out[field] = value - Number(minus[field] ?? 0);
			}
			return out;
		})
		.filter((row) => Number(row[countField] ?? 0) > 0);
}

function sortRows(rows: GroupRow[], sort?: Record<string, 1 | -1>): GroupRow[] {
	if (!sort) return rows;
	const keys = Object.entries(sort);
	return [...rows].sort((a, b) => {
		for (const [field, direction] of keys) {
			const av = a[field] as number | string;
			const bv = b[field] as number | string;
			if (av < bv) return -direction;
			if (av > bv) return direction;
		}
		return 0;
	});
}

export async function groupCountsExcluding<K extends string>(
	model: Aggregator,
	specs: Record<K, GroupSpec>,
	excludedIds: readonly string[]
): Promise<Record<K, GroupRow[]>> {
	const keys = Object.keys(specs) as K[];
	const facet = Object.fromEntries(keys.map((key) => [key, stages(specs[key])]));
	const [totals, excluded] = await Promise.all([
		Promise.all(keys.map(async (key) => (await model.aggregate(stages(specs[key]))) as GroupRow[])),
		excludedIds.length === 0
			? ({} as Record<string, GroupRow[]>)
			: model
					.aggregate([{ $match: { _id: { $in: [...excludedIds] } } }, { $facet: facet as PipelineStage.Facet['$facet'] }])
					.then((rows) => ((rows as Record<string, GroupRow[]>[])[0] ?? {}))
	]);
	return Object.fromEntries(
		keys.map((key, i) => [key, sortRows(subtractRows(totals[i], excluded[key] ?? []), specs[key].sort)])
	) as Record<K, GroupRow[]>;
}

/** A count spec (`_id: null`) reads back as a number. */
export const totalOf = (rows: GroupRow[] | undefined) => Number(rows?.[0]?.count ?? 0);

export const countSpec = (match: Record<string, unknown>): GroupSpec => ({
	match,
	group: { _id: null, count: { $sum: 1 } }
});

export const countBy = (match: Record<string, unknown>, field: string, sort?: Record<string, 1 | -1>): GroupSpec => ({
	match,
	group: { _id: `$${field}`, count: { $sum: 1 } },
	sort
});
