import { describe, it, expect } from 'vitest';
import { evaluateScreenRows, onCurrentGainScale, criterionFor, screenTestLabel, screenTestDoc, baseTestId, parseScreenEvent, type ScreenRow } from './contract';

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

describe('v108 tiered screen rows', () => {
	it('labels quick-tier motion rows and per-well rows', () => {
		expect(screenTestLabel('q_err')).toBe('Quick run home error, summed over the run (µm)');
		expect(screenTestLabel('q_w3_err')).toBe('Quick run well block 3 home error (µm)');
		expect(screenTestLabel('run2_w1_err')).toBe('Run 2 well block 1 home error (µm)');
		expect(screenTestLabel('run2_end')).toBe('Run 2 final home error (µm)');
		expect(screenTestLabel('q_heat_rate')).toBe('Quick: heater heat-up rate (°C/min ×10)');
		expect(screenTestLabel('tier_gate')).toBe('Tier gate (1 = continued to full screen)');
	});
	it('keeps the well number on per-well ids', () => {
		expect(baseTestId('q_w2_err')).toBe('q_w2_err');
		expect(baseTestId('q_heat_t90')).toBe('q_heat_t90');
	});
	it('documents per-well rows', () => {
		expect(screenTestDoc('run1_w4_err').rule).toMatch(/500/);
		expect(screenTestDoc('q_hits').rule).toBe('fail if any');
	});
	it('reads the gate from the summary', () => {
		const s = parseScreenEvent({ v: 1, fw: 108, run: 4, lvl: 9, pass: 1, fail: 1, levels: 'T0123', reps: 3, gate: 'q_err', skipped: 1 }) as any;
		expect(s.gate).toBe('q_err');
		expect(s.skipped).toBe(true);
		const t = parseScreenEvent({ v: 1, fw: 107, run: 4, lvl: 9, levels: '0123', reps: 3 }) as any;
		expect(t.gate).toBeNull();
		expect(t.skipped).toBe(false);
	});
});
