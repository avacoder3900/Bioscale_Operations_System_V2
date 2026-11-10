import { describe, expect, it } from 'vitest';
import { answeredRow, piEventRows, receivedRow, wifiText } from './drive-log';
import { groupOfKind } from './move-types';

const t0 = new Date('2026-11-10T15:00:31.000Z');

describe('arm Pi drive-step rows', () => {
	it('pairs BIMS received and answered rows by the Pi request id', () => {
		const info = { loopId: 'L1', action: 'awaitParked', reqId: 'ab12-3', attempt: 1, receivedAt: t0, vercelId: 'iad1::x' };
		const a = receivedRow(info);
		const b = answeredRow({ ...info, answeredAt: new Date(t0.getTime() + 53_800), status: 200, error: null, region: 'iad1' });
		expect(a.kind).toBe('drive_received');
		expect(b.kind).toBe('drive_answered');
		expect(a.reqId).toBe('ab12-3');
		expect(b.reqId).toBe('ab12-3');
		expect(a._id).not.toBe(b._id);
		expect(b.durationMs).toBe(53_800);
		expect(b.ok).toBe(true);
		expect(b.line).toBe('Arm Pi Step  awaitParked  Answered 200  53800 ms  req ab12-3');
	});

	it('marks a refused step as not ok', () => {
		const b = answeredRow({ loopId: 'L1', action: 'cycleGrab', reqId: null, attempt: null, receivedAt: t0, answeredAt: t0, status: 409, error: 'Stop was requested', vercelId: null, region: null });
		expect(b.ok).toBe(false);
		expect(b.error).toBe('Stop was requested');
		expect(b.reqId).toBeUndefined();
	});

	it("turns the Pi's log into step and note rows, the step timed from when it was sent", () => {
		const at = t0.getTime() / 1000 + 130.277;
		const rows = piEventRows('L1', [
			{ at, sent_at: t0.getTime() / 1000, action: 'awaitParked', ok: false, ms: 130277, error: 'ReadTimeout: The read operation timed out', req: 'ab12-3', wifi: { iface: 'wlan0', link: 52, level: -58 } },
			{ at: at + 0.3, note: 'grab failed: ReadTimeout' },
			{ note: 'no time, dropped' },
			null
		]);
		expect(rows).toHaveLength(2);
		expect(rows[0].kind).toBe('pi_drive_step');
		expect(rows[0].at.toISOString()).toBe(t0.toISOString());
		expect(rows[0].durationMs).toBe(130277);
		expect(rows[0].ok).toBe(false);
		expect(rows[0]._id).toBe('pidrv-ab12-3');
		expect(rows[0].line).toBe('Pi Step  awaitParked  failed  130277 ms  req ab12-3  Wi-Fi -58 dBm link 52');
		expect(rows[1].kind).toBe('pi_drive_note');
		expect(rows[1].line).toBe('Pi Note  grab failed: ReadTimeout');
	});

	it('gives the same ids when the Pi sends its log twice', () => {
		const ev = [{ at: 1794322961.27, action: 'loopState', ok: true, ms: 300, req: 'r1' }, { at: 1794322961.5, note: 'n' }];
		expect(piEventRows('L1', ev).map((r) => r._id)).toEqual(piEventRows('L1', ev).map((r) => r._id));
	});

	it('writes no Wi-Fi text when the Pi could not read it', () => {
		expect(wifiText(null)).toBe('');
		expect(wifiText({ iface: 'wlan0', link: null, level: null })).toBe('');
	});

	it('files the drive rows and OT-2 hops under the link', () => {
		expect(groupOfKind('link', 'pi_drive_step')?.id).toBe('link:drive');
		expect(groupOfKind('link', 'drive_answered')?.title).toBe('Arm Pi Drive Step');
		expect(groupOfKind('link', 'ot2_call')?.id).toBe('link:hop');
	});
});
