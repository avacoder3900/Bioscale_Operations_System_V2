import { describe, expect, it } from 'vitest';
import { applyIgnores, type IgnoreRule, type ManualIgnore } from './ignore';
import { summarizeAnomalies, type Anomaly } from './window';

const an = (id: string, p: Partial<Anomaly>): Anomaly => ({
	id,
	kind: 'tone',
	t: 10,
	t0: 9.8,
	t1: 10.4,
	step: 20,
	stepLabel: null,
	fLo: 1000,
	fHi: 1200,
	deltaDb: 15,
	z: 9,
	severity: 'medium',
	note: '',
	...p
});
const rule = (p: Partial<IgnoreRule>): IgnoreRule => ({ id: 'R', name: 'r', reason: 'why', kind: null, stepFrom: null, stepTo: null, fMinHz: null, fMaxHz: null, by: 'x', at: null, ...p });

describe('ignoring anomalies', () => {
	const list = [
		an('A1', {}),
		an('A2', { t: 220, t0: 219.9, t1: 221, step: 48, kind: 'click' }), // end-of-test beep
		an('A3', { t: 50, t0: 49.9, t1: 50.3, fLo: 11000, fHi: 14000 }) // high-frequency artifact
	];
	it('applies step and frequency rules, and leaves the rest in play', () => {
		const out = applyIgnores(list, [], [rule({ id: 'beep', stepFrom: 47, stepTo: 48 }), rule({ id: 'hf', fMinHz: 8000 })]);
		expect(out.map((a) => a.ignored?.id ?? null)).toEqual([null, 'beep', 'hf']);
		const sum = summarizeAnomalies(out, 3, false);
		expect(sum.total).toBe(1);
		expect(sum.ignored).toBe(2);
		expect(sum.stepsWithAnomalies).toEqual([20]);
	});
	it('re-finds a manually ignored sound after re-analysis renumbers it, until it is restored', () => {
		const m: ManualIgnore = { id: 'M', t: 10.05, t0: 9.85, t1: 10.35, fLo: 1050, fHi: 1150, kind: 'tone', step: 20, reason: 'room noise', by: 'x', at: '' };
		const renumbered = [an('A7', { t: 10.1 })];
		expect(applyIgnores(renumbered, [m], [])[0].ignored).toMatchObject({ source: 'manual', id: 'M', reason: 'room noise' });
		expect(applyIgnores(renumbered, [{ ...m, removedAt: 'now' }], [])[0].ignored).toBeNull();
		// A different sound (other time) is not caught by it.
		expect(applyIgnores([an('A8', { t: 30, t0: 29.9, t1: 30.2 })], [m], [])[0].ignored).toBeNull();
	});
});
