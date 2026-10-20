import { describe, expect, it } from 'vitest';
import { countBy, countSpec, groupCountsExcluding, subtractRows, totalOf, type Aggregator } from './checked-out-counts';

interface Cart {
	_id: string;
	status: string;
	qc?: string;
}

const CARTS: Cart[] = [
	{ _id: 'a', status: 'stored', qc: 'Accepted' },
	{ _id: 'b', status: 'stored', qc: 'Rejected' },
	{ _id: 'c', status: 'scrapped', qc: 'Rejected' },
	{ _id: 'd', status: 'voided' },
	{ _id: 'e', status: 'stored', qc: 'Accepted' }
];

const matches = (cart: Cart, match: Record<string, unknown>) =>
	Object.entries(match).every(([field, cond]) => {
		const value = (cart as unknown as Record<string, unknown>)[field];
		if (cond && typeof cond === 'object') {
			const c = cond as Record<string, unknown>;
			if ('$in' in c) return (c.$in as unknown[]).includes(value);
			if ('$nin' in c) return !(c.$nin as unknown[]).includes(value);
			if ('$ne' in c) return value !== c.$ne;
			if ('$exists' in c) return (value !== undefined) === c.$exists;
		}
		return value === cond;
	});

/** A tiny in-memory aggregate: $match, $group with $sum:1, and $facet. */
const run = (docs: Cart[], pipeline: readonly object[]): unknown[] => {
	let rows: unknown[] = docs;
	for (const raw of pipeline) {
		const stage = raw as Record<string, unknown>;
		if (stage.$match) rows = (rows as Cart[]).filter((d) => matches(d, stage.$match as Record<string, unknown>));
		if (stage.$group) {
			const { _id } = stage.$group as { _id: string | null };
			const groups = new Map<string, { _id: unknown; count: number }>();
			for (const d of rows as Cart[]) {
				const id = _id ? (d as unknown as Record<string, unknown>)[_id.slice(1)] ?? null : null;
				const g = groups.get(JSON.stringify(id)) ?? { _id: id, count: 0 };
				g.count += 1;
				groups.set(JSON.stringify(id), g);
			}
			rows = [...groups.values()];
		}
		if (stage.$facet) {
			const facet = stage.$facet as Record<string, Record<string, unknown>[]>;
			rows = [Object.fromEntries(Object.entries(facet).map(([k, p]) => [k, run(rows as Cart[], p)]))];
		}
	}
	return rows;
};

const memory: Aggregator = { aggregate: async (pipeline) => run(CARTS, pipeline) };

describe('groupCountsExcluding (PERF-01 BM-02)', () => {
	const checkedOut = ['b', 'c'];
	const specs = {
		byStatus: countBy({ status: { $ne: null } }, 'status', { count: -1 }),
		byQc: countBy({ qc: { $exists: true } }, 'qc'),
		notVoided: countSpec({ status: { $ne: 'voided' } })
	};

	it('equals the $nin result for every spec', async () => {
		const got = await groupCountsExcluding(memory, specs, checkedOut);
		for (const [key, spec] of Object.entries(specs)) {
			const expected = run(CARTS, [{ $match: { ...spec.match, _id: { $nin: checkedOut } } }, { $group: spec.group }]);
			const sortById = (rows: unknown[]) => [...(rows as { _id: unknown }[])].sort((a, b) => String(a._id).localeCompare(String(b._id)));
			expect(sortById(got[key as keyof typeof specs])).toEqual(sortById(expected));
		}
		expect(totalOf(got.notVoided)).toBe(2);
	});

	it('drops groups emptied by the exclusion, as $nin would', async () => {
		const got = await groupCountsExcluding(memory, specs, checkedOut);
		expect(got.byStatus.map((r) => r._id)).not.toContain('scrapped');
		expect(got.byStatus[0]).toEqual({ _id: 'stored', count: 2 });
	});

	it('skips the second read when nothing is checked out', async () => {
		let calls = 0;
		const counting: Aggregator = { aggregate: async (p) => { calls += 1; return run(CARTS, p); } };
		await groupCountsExcluding(counting, specs, []);
		expect(calls).toBe(Object.keys(specs).length);
	});

	it('subtracts every numeric accumulator, not just count', () => {
		const totals = [{ _id: '2026-10-19', count: 5, passed: 3, failed: 2 }];
		const excluded = [{ _id: '2026-10-19', count: 1, passed: 0, failed: 1 }];
		expect(subtractRows(totals, excluded)).toEqual([{ _id: '2026-10-19', count: 4, passed: 3, failed: 1 }]);
	});
});
