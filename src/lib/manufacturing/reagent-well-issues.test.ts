import { describe, it, expect } from 'vitest';
import { wellLogWindow, POST_RUN_WELL_LOG_HOURS } from './reagent-well-issues';

const H = 3_600_000;
const end = new Date('2026-10-21T16:00:00Z');

describe('wellLogWindow', () => {
	it('is open (live) while the run is running', () => {
		expect(wellLogWindow({ status: 'Running' })).toEqual({ open: true, postRun: false });
	});

	it('stays open after a run completes, flagged postRun', () => {
		const w = wellLogWindow({ status: 'Completed', finalizedAt: end }, end.getTime() + 1 * H);
		expect(w.open).toBe(true);
		expect(w).toMatchObject({ postRun: true });
	});

	it('treats a finalized run as finished even before the status flips', () => {
		const w = wellLogWindow({ status: 'Running', finalizedAt: end }, end.getTime() + H);
		expect(w).toMatchObject({ open: true, postRun: true });
	});

	it('closes after the post-run window', () => {
		const w = wellLogWindow({ status: 'Completed', finalizedAt: end }, end.getTime() + (POST_RUN_WELL_LOG_HOURS + 1) * H);
		expect(w.open).toBe(false);
	});

	it('falls back to runEndTime when finalizedAt is missing', () => {
		const w = wellLogWindow({ status: 'Completed', runEndTime: end.toISOString() }, end.getTime() + H);
		expect(w).toMatchObject({ open: true, postRun: true });
	});

	it('is closed for aborted / voided / cancelled runs', () => {
		for (const status of ['Aborted', 'voided', 'Cancelled']) {
			expect(wellLogWindow({ status, finalizedAt: end }, end.getTime()).open).toBe(false);
		}
	});

	it('is closed for a finished run with no end time', () => {
		expect(wellLogWindow({ status: 'Completed' }).open).toBe(false);
	});
});
