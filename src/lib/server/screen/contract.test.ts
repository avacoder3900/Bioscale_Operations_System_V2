import { describe, it, expect } from 'vitest';
import { evaluateScreenRows, onCurrentGainScale, criterionFor, type ScreenRow } from './contract';

const row = (id: string, status: ScreenRow['status'], value: number, limit: number | null = null): ScreenRow => ({ id, status, value, limit, ms: 0, note: null, level: 0, part: 1 });

describe('fs_val built-in criterion', () => {
	it('clears the device warning at the pruned steady state (45-50 files)', () => {
		const [r] = evaluateScreenRows([row('fs_val', 'W', 50, 50)], null);
		expect(r.finalStatus).toBe('P');
	});
	it('still warns above the cap (pruning not working)', () => {
		const [r] = evaluateScreenRows([row('fs_val', 'P', 51, 50)], {});
		expect(r.finalStatus).toBe('W');
	});
	it('yields to a saved criterion for the same id', () => {
		expect(criterionFor('fs_val', { fs_val: { ignore: true } })?.ignore).toBe(true);
	});
	it('leaves ids without a built-in alone', () => {
		expect(criterionFor('homerep1', null)).toBeNull();
	});
});

describe('bench-gain era', () => {
	it('drops gain-dependent rows from screens before v107', () => {
		expect(onCurrentGainScale('lsrA_c', 106)).toBe(false);
		expect(onCurrentGainScale('lsrA_f1', 106)).toBe(false);
		expect(onCurrentGainScale('drkB', 105)).toBe(false);
	});
	it('keeps them from v107 on, and keeps gain-independent rows always', () => {
		expect(onCurrentGainScale('lsrA_c', 107)).toBe(true);
		expect(onCurrentGainScale('lsrA', 106)).toBe(true);
		expect(onCurrentGainScale('homerep', 106)).toBe(true);
	});
});
