import { describe, expect, it } from 'vitest';
import { prunePlan } from './robot-prune';

const run = (id: string, day: number, protocolId = 'p1', status = 'stopped') => ({ id, createdAt: `2026-11-${String(day).padStart(2, '0')}T10:00:00Z`, protocolId, status });

describe('prunePlan', () => {
	it('keeps the newest runs and the current one, drops the older ended ones', () => {
		const runs = [run('a', 1), run('b', 2), run('c', 3), run('d', 4), run('e', 5), run('f', 6), run('g', 7)];
		const plan = prunePlan(runs, [], 'a', new Set(), 3);
		expect(plan.runs.sort()).toEqual(['b', 'c', 'd']);
	});
	it('never drops a run that has not ended', () => {
		const runs = [run('a', 1, 'p1', 'running'), run('b', 2), run('c', 3)];
		expect(prunePlan(runs, [], null, new Set(), 1).runs).toEqual(['b']);
	});
	it('keeps registered protocols and those a kept run uses', () => {
		const runs = [run('a', 1, 'old'), run('b', 9, 'used')];
		const protocols = [{ id: 'old' }, { id: 'used' }, { id: 'loose' }, { id: 'reg' }];
		const plan = prunePlan(runs, protocols, 'b', new Set(['reg']), 1);
		expect(plan.runs).toEqual(['a']);
		expect(plan.protocols.sort()).toEqual(['loose', 'old']);
	});
});
