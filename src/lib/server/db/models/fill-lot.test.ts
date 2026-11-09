import { describe, it, expect } from 'vitest';
import { fillLotDay, fillLotNumber, dayFillLotFilter } from './fill-lot';

describe('fill lot = one reagent lot on one Central day', () => {
	it('dates a fill by the Central day, so an evening fill is not tomorrow', () => {
		expect(fillLotDay(new Date('2026-11-03T16:49:00Z'))).toBe('20261103');
		// 23:37 UTC and 03:30 UTC next day are both still 11/3 in Central time
		expect(fillLotDay(new Date('2026-11-03T23:37:00Z'))).toBe('20261103');
		expect(fillLotDay(new Date('2026-11-04T03:30:00Z'))).toBe('20261103');
		expect(fillLotNumber(new Date('2026-11-04T03:30:00Z'), 2)).toBe('FL-20261103-002');
		// daylight time (UTC-5)
		expect(fillLotNumber(new Date('2026-07-01T04:30:00Z'), 1)).toBe('FL-20260630-001');
	});

	it("looks up the day's open lot by reagent lot, or the non-calibrated lot by assay", () => {
		expect(dayFillLotFilter('20261103', { reagentLotId: 'rl1' })).toEqual({ fillLotNumber: { $regex: '^FL-20261103-' }, status: 'open', reagentLotId: 'rl1' });
		expect(dayFillLotFilter('20261103', { nonCalibrated: true, assayId: 'A56E0F5A' })).toEqual({ fillLotNumber: { $regex: '^FL-20261103-' }, status: 'open', reagentLotSource: 'non-calibrated', assayId: 'A56E0F5A' });
	});
});
