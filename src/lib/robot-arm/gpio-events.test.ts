import { describe, expect, it } from 'vitest';
import { gpioEventLine, gpioEventRow, gpioWarningRow, gpioWarnings, matchBimsPulse, type PiGpioEvent } from './gpio-events';
import { groupOfKind } from './move-types';
import { kindTitle } from './move-log';

const on: PiGpioEvent = { id: 'b1-5', at: '2026-11-24T15:00:00.000Z', pin: 17, state: 1, source: 'replay-fire', ms: 100, run_id: 'R42' };
const off: PiGpioEvent = { id: 'b1-6', at: '2026-11-24T15:00:00.102Z', pin: 17, state: 0, source: 'replay-fire', held_ms: 102, run_id: 'R42' };

describe('gpio event rows', () => {
	it('names the pin, state, source and pulse', () => {
		expect(gpioEventLine(on)).toBe('Trapdoor A · GPIO 17 On  Replay Fire  100 ms  Run R42');
		expect(gpioEventLine(off)).toBe('Trapdoor A · GPIO 17 Off  Replay Fire  Held 102 ms  Run R42');
		expect(gpioEventLine({ ...on, pin: 22, source: 'loop-driver', loop_id: 'L7', ms: 600 })).toBe('Conveyor Belt · GPIO 22 · Pin 15 On  Loop Driver  600 ms  Loop L7');
		expect(gpioEventLine({ id: 'b1-1', at: on.at, pin: 27, state: 1, source: 'boot' })).toBe('Trapdoor B · GPIO 27 Found High At Service Start');
	});

	it('keys the row on the Pi event id and flags an outside change', () => {
		const r = gpioEventRow(on)!;
		expect(r._id).toBe('gpio-b1-5');
		expect(r.device).toBe('gpio');
		expect(r.kind).toBe('gpio_on');
		expect(r.runId).toBe('R42');
		expect(r.ok).toBe(true);
		expect(gpioEventRow(off)!.durationMs).toBe(102);
		const u = gpioEventRow({ ...on, source: 'unknown', note: 'changed with no write from this service' })!;
		expect(u.ok).toBe(false);
		expect(u.error).toBe('changed with no write from this service');
		expect(gpioEventRow({ ...on, at: 'nope' })).toBeNull();
	});

	it('takes the user from the BIMS fire row it came from', () => {
		const e = { ...on, source: 'bims-pulse' };
		const rows = [
			{ at: '2026-11-24T14:59:40.000Z', movedBy: { username: 'old' } },
			{ at: '2026-11-24T14:59:59.800Z', movedBy: { username: 'alejandro' }, from: '/teach' }
		];
		expect(matchBimsPulse(e, rows)?.movedBy?.username).toBe('alejandro');
		expect(matchBimsPulse(on, rows)).toBeNull();
		expect(gpioEventRow(e, { movedBy: { username: 'alejandro' }, from: '/teach' })!.from).toBe('/teach');
	});

	it('is in the GPIO groups with titled kinds', () => {
		expect(groupOfKind('gpio', 'gpio_on')?.id).toBe('gpio:pin');
		expect(groupOfKind('gpio', 'gpio_unexplained')?.id).toBe('gpio:warning');
		expect(kindTitle('gpio_boot')).toBe('Pin At Start');
	});
});

describe('gpio warnings', () => {
	const now = '2026-11-24T15:00:00.500Z';

	it('is quiet for a pin high inside its pulse', () => {
		expect(gpioWarnings({ pins: { '17': 1 }, last: { '17': on }, now })).toEqual([]);
	});

	it('warns for a high pin whose newest event is not an on', () => {
		const w = gpioWarnings({ pins: { '17': 1, '27': 0 }, last: { '17': off }, now });
		expect(w).toHaveLength(1);
		expect(w[0]).toMatchObject({ pin: 17, kind: 'gpio_unexplained', lastEventId: 'b1-6' });
		expect(w[0].line).toBe('⚠ Trapdoor A · GPIO 17 High  No On Event');
		expect(gpioWarnings({ pins: { '17': 1 }, last: {}, now })[0].line).toBe('⚠ Trapdoor A · GPIO 17 High  No Event');
		expect(gpioWarnings({ pins: { '27': 1 }, last: { '27': { ...on, pin: 27, source: 'boot' } }, now })[0].line).toContain('Found High At Service Start');
	});

	it('names a pin that reads high while driven low', () => {
		const odd = { id: 'b2-9', at: now, pin: 17, state: 1, source: 'unknown', driven: 0, note: 'reads high while driven low' };
		expect(gpioEventLine(odd)).toBe('Trapdoor A · GPIO 17 Reads High While Driven Low');
		expect(gpioEventLine({ ...odd, note: 'still: 200 of 600 reads high', odd_reads: 200, reads: 600 })).toBe('Trapdoor A · GPIO 17 Still Reads High While Driven Low  200 Of 600 Reads High');
		expect(gpioEventLine({ ...odd, state: 0, note: 'reads as driven (low) again; 3 of 70 reads were high over 70 s', odd_reads: 3, reads: 70 })).toBe('Trapdoor A · GPIO 17 Reads As Driven Again  3 Of 70 Reads High');
		expect(gpioWarnings({ pins: { '17': 1 }, last: { '17': odd }, now })[0].line).toBe('⚠ Trapdoor A · GPIO 17 High  Reads High While Driven Low');
	});

	it('warns for a pin still high long after its pulse', () => {
		const w = gpioWarnings({ pins: { '17': 1 }, last: { '17': on }, now: '2026-11-24T15:00:12.000Z' });
		expect(w[0].kind).toBe('gpio_stuck');
		expect(w[0].line).toBe('⚠ Trapdoor A · GPIO 17 Still High 12.0 s After A 100 ms Pulse  Replay Fire');
	});

	it('skips pins the Pi has not claimed', () => {
		expect(gpioWarnings({ pins: { '17': null }, last: {}, now })).toEqual([]);
	});

	it('writes one row per pin per newest event', () => {
		const [w] = gpioWarnings({ pins: { '17': 1 }, last: { '17': off }, now });
		const a = gpioWarningRow(w, new Date(now), 'b1');
		const b = gpioWarningRow(w, new Date('2026-11-24T15:00:03.500Z'), 'b1');
		expect(a._id).toBe(b._id);
		expect(a.ok).toBe(false);
		expect(a.kind).toBe('gpio_unexplained');
	});
});
