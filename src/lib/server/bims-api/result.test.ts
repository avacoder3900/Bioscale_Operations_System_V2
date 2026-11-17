import { describe, expect, it } from 'vitest';
import { curveOf, iso, ngPerMlFactor, reduceResult, runState, type StoredWell } from './result';
import type { WellId } from './analytes';

const A: readonly WellId[] = ['A'];
const ABC: readonly WellId[] = ['A', 'B', 'C'];

const well = (status: string, value: number | null, over: Partial<StoredWell> & { unit?: string | null; pass?: boolean; flags?: string[] } = {}): StoredWell => ({
	qc: { pass: over.pass ?? true, flags: (over.flags ?? []).map((key) => ({ key })) },
	quant: { status, value, unit: over.unit === undefined ? 'ng/mL' : over.unit, curveId: 'c1', curveVersion: 3, curveSource: 'own' }
});
const analysis = (wells: Record<string, StoredWell>) => ({ schemaVersion: 2, wells });

describe('reduceResult: channel A only (cortisol)', () => {
	const cases: [string, Record<string, StoredWell>, { status: string; value: number | null }][] = [
		['ok', { A: well('ok', 12.4) }, { status: 'ok', value: 12.4 }],
		['below range (censored: no value)', { A: well('below_range', 0) }, { status: 'below_range', value: null }],
		['above range (censored: no value)', { A: well('above_range', 567.1) }, { status: 'above_range', value: null }],
		['QC failed', { A: well('ok', 12.4, { pass: false, flags: ['qc:A:high_baseline'] }) }, { status: 'qc_fail', value: null }],
		['no readout', { A: well('no_readout', null, { unit: '' }) }, { status: 'qc_fail', value: null }],
		['no curve', { A: well('no_curve', null, { unit: '' }) }, { status: 'not_calibrated', value: null }],
		['no lot', { A: well('no_lot', null, { unit: '' }) }, { status: 'not_calibrated', value: null }],
		['engine error', { A: well('error', null) }, { status: 'not_calibrated', value: null }],
		['no wells stored', {}, { status: 'not_calibrated', value: null }],
		['below range beats a failed QC', { A: well('below_range', 0, { pass: false }) }, { status: 'below_range', value: null }]
	];
	it.each(cases)('%s', (_n, wells, expected) => {
		expect(reduceResult(analysis(wells), A)).toMatchObject(expected);
	});

	it('ignores wells B and C entirely: value, status, QC and flags', () => {
		const r = reduceResult(
			analysis({
				A: well('ok', 12.4),
				B: well('above_range', 567.1, { pass: false, flags: ['qc:B:channel_disagreement'] }),
				C: well('ok', 400, { unit: 'nmol/L', flags: ['qc:C:no_readings'] })
			}),
			A
		);
		expect(r).toEqual({
			value: 12.4,
			unit: 'ng/mL',
			status: 'ok',
			reportedWells: ['A'],
			wells: [{ well: 'A', value: 12.4, status: 'ok', qcPass: true, flags: [] }],
			qualityFlags: []
		});
	});

	it('a good B does not rescue a failed A', () => {
		const r = reduceResult(analysis({ A: well('no_curve', null, { unit: '' }), B: well('ok', 50) }), A);
		expect(r).toMatchObject({ status: 'not_calibrated', value: null, wells: [{ well: 'A' }] });
	});

	it('an absent qc.pass counts as passed', () => {
		expect(reduceResult(analysis({ A: { quant: { status: 'ok', value: 9, unit: 'ng/mL' } } }), A)).toMatchObject({ status: 'ok', value: 9, wells: [{ qcPass: true }] });
	});
});

describe('reduceResult: a multi-well analyte', () => {
	it('median of the passing wells (odd)', () => {
		expect(reduceResult(analysis({ A: well('ok', 10), B: well('ok', 30), C: well('ok', 14) }), ABC)).toMatchObject({ status: 'ok', value: 14 });
	});
	it('median of the passing wells (even), a QC-failed well left out', () => {
		const r = reduceResult(analysis({ A: well('ok', 10), B: well('ok', 30), C: well('ok', 999, { pass: false, flags: ['qc:C:x'] }) }), ABC);
		expect(r).toMatchObject({ status: 'ok', value: 20, qualityFlags: ['qc:C:x'] });
		expect(r.wells.map((w) => w.qcPass)).toEqual([true, true, false]);
	});
	it('one ok well is enough, whatever the others say', () => {
		expect(reduceResult(analysis({ A: well('below_range', 0), B: well('ok', 30), C: well('no_readout', null) }), ABC)).toMatchObject({ status: 'ok', value: 30 });
	});
	it('precedence without an ok well: below > above > qc_fail > not_calibrated', () => {
		expect(reduceResult(analysis({ A: well('above_range', 500), B: well('below_range', 0), C: well('no_readout', null) }), ABC).status).toBe('below_range');
		expect(reduceResult(analysis({ A: well('above_range', 500), B: well('no_readout', null), C: well('no_curve', null) }), ABC).status).toBe('above_range');
		expect(reduceResult(analysis({ A: well('no_curve', null), B: well('no_readout', null) }), ABC).status).toBe('qc_fail');
		expect(reduceResult(analysis({ A: well('no_curve', null), B: well('no_curve', null, { pass: false }) }), ABC).status).toBe('not_calibrated');
		expect(reduceResult(analysis({ A: well('ok', 5, { pass: false }), B: well('ok', 6, { pass: false }) }), ABC).status).toBe('qc_fail');
	});
	it('flags are de-duplicated in well order; reportedWells lists the analyte\'s wells, wells only those stored', () => {
		const r = reduceResult(analysis({ A: well('ok', 10, { flags: ['f1', 'f2'] }), C: well('ok', 12, { flags: ['f2', 'f3'] }) }), ABC);
		expect(r.qualityFlags).toEqual(['f1', 'f2', 'f3']);
		expect(r.reportedWells).toEqual(['A', 'B', 'C']);
		expect(r.wells.map((w) => w.well)).toEqual(['A', 'C']);
	});
});

describe('units', () => {
	it.each([
		['ng/mL', 1], ['ng/ml', 1], [' NG/ML ', 1], ['µg/L', 1], ['ug/L', 1],
		['µg/dL', 10], ['μg/dL', 10], ['ug/dl', 10], ['ng/dL', 0.01], ['pg/mL', 0.001], ['µg/mL', 1000]
	])('%s → ×%d', (unit, factor) => {
		expect(ngPerMlFactor(unit)).toBe(factor);
	});
	it.each(['nmol/L', 'mIU/L', '', null, undefined, 'ng'])('%s is refused', (unit) => {
		expect(ngPerMlFactor(unit as any)).toBeNull();
	});
	it('converts µg/dL to ng/mL', () => {
		const r = reduceResult(analysis({ A: well('ok', 1.24, { unit: 'µg/dL' }) }), A);
		expect(r.status).toBe('ok');
		expect(r.unit).toBe('ng/mL');
		expect(r.value).toBeCloseTo(12.4);
		expect(r.wells[0].value).toBeCloseTo(12.4);
	});
	it('never relabels: a molar or missing unit on a numeric value is unit_unsupported with no number', () => {
		for (const unit of ['nmol/L', '', null]) {
			const r = reduceResult(analysis({ A: well('ok', 34.2, { unit }) }), A);
			expect(r).toMatchObject({ status: 'unit_unsupported', value: null, unit: 'ng/mL' });
			expect(r.wells[0].value).toBeNull();
		}
	});
	it('a well with no number has no unit to object to', () => {
		expect(reduceResult(analysis({ A: well('no_curve', null, { unit: '' }) }), A).status).toBe('not_calibrated');
	});
});

describe('curveOf, runState, iso', () => {
	it('reads the curve off the first reported well', () => {
		expect(curveOf(analysis({ A: well('ok', 1) }), A)).toEqual({ id: 'c1', version: 3, source: 'own' });
		expect(curveOf(analysis({ B: well('ok', 1) }), A)).toEqual({ id: null, version: null, source: null });
		expect(curveOf(null, A)).toEqual({ id: null, version: null, source: null });
	});
	it.each([
		['linked', true, true, 'linked', null],
		['underway', true, true, 'running', null],
		['completed', true, true, 'completed', null],
		['completed', false, true, 'running', 'analysis_pending'],
		['completed', true, false, 'running', 'assay_unsupported'],
		['cancelled', true, true, 'cancelled', null],
		['voided', true, true, 'cancelled', 'not_linked'],
		['stored', true, true, 'cancelled', 'not_linked'],
		[undefined, true, true, 'cancelled', 'not_linked']
	] as const)('status %s (analysed %s, known assay %s) → %s / %s', (status, analysed, knownAssay, state, detail) => {
		expect(runState(status, { analysed, knownAssay })).toEqual({ state, detail });
	});
	it('iso', () => {
		expect(iso('2026-11-10T14:31:02Z')).toBe('2026-11-10T14:31:02.000Z');
		expect(iso(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
		expect(iso('')).toBeNull();
		expect(iso(undefined)).toBeNull();
		expect(iso('not a date')).toBeNull();
	});
});
