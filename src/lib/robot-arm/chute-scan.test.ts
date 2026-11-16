import { describe, expect, it } from 'vitest';
import { chuteScanLine, chuteWarningText, isWholeCartLabel, parseChuteScansBody } from './chute-scan';

const LABEL = '9bfb7605-291f-43a6-a028-72234c15f19f';

describe('chute scans', () => {
	it('a whole label only', () => {
		expect(isWholeCartLabel(LABEL)).toBe(true);
		expect(isWholeCartLabel('CART-000123')).toBe(true);
		expect(isWholeCartLabel(LABEL.slice(0, 20))).toBe(false);
		expect(isWholeCartLabel(LABEL + LABEL)).toBe(false);
	});

	it('parses the Pi body and recomputes ok from the code', () => {
		const { host, scans } = parseChuteScansBody({
			host: 'alejandrospi3',
			scans: [
				{ id: 'x1', at: '2026-11-16T18:00:00Z', ok: true, code: LABEL, elapsed_ms: 80, solenoid: 'A', pin: 17, run_id: 'R1', title: 'Drop A' },
				{ id: 'x2', ok: true, code: LABEL.slice(0, 30) },
				{ id: 'x3', ok: false, error: 'no barcode read' }
			]
		});
		expect(host).toBe('alejandrospi3');
		expect(scans[0]).toMatchObject({ ok: true, code: LABEL, label: true, error: null, elapsedMs: 80, solenoid: 'A', pin: 17, runId: 'R1', title: 'Drop A', piScanId: 'x1' });
		expect(scans[1]).toMatchObject({ ok: false, label: false, error: 'not a whole cartridge label' });
		expect(scans[2]).toMatchObject({ ok: false, code: null, error: 'no barcode read' });
		expect(parseChuteScansBody(null).scans).toEqual([]);
	});

	it('lines and warning text', () => {
		expect(chuteScanLine({ ok: true, code: LABEL, error: null, solenoid: 'A' })).toBe(`Chute Barcode Scan After Solenoid A  ${LABEL}`);
		expect(chuteScanLine({ ok: false, code: null, error: 'no barcode read', solenoid: 'B' })).toBe('Chute Barcode Scan After Solenoid B  Failed: no barcode read');
		const now = new Date('2026-11-16T18:02:00Z');
		expect(
			chuteWarningText({ _id: 's', at: '2026-11-16T18:00:00Z', code: null, error: 'no barcode read', solenoid: 'A', title: 'Drop A', failedCount: 1 }, now)
		).toBe('Chute Scan Failed: no barcode read after Solenoid A in Drop A, 2 min ago');
		expect(
			chuteWarningText({ _id: 's', at: '2026-11-16T18:01:50Z', code: 'abc', error: 'not a whole cartridge label', solenoid: null, title: null, failedCount: 3 }, now)
		).toBe('Chute Scan Failed: not a whole cartridge label (abc), 10 s ago · 3 failed scans');
	});
});
