import { describe, expect, it } from 'vitest';
import { camelTitle, commandTiming, loopStepLine, ot2CommandLine, pickLoggable, runNames, summarizeTiming } from './ot2-move-log';
import { kindTitle, summarizeServoMoves } from './move-log';

const names = runNames({
	labware: [{ id: 'lw1', loadName: 'wax_tube', displayName: 'Wax Tube', location: { slotName: '3' } }],
	pipettes: [{ id: 'p1', pipetteName: 'p300_single_gen2', mount: 'left' }]
});

describe('ot2CommandLine', () => {
	it('reads a labware aspirate with volume, well, origin offset and flow', () => {
		const line = ot2CommandLine(
			{ commandType: 'aspirate', params: { pipetteId: 'p1', labwareId: 'lw1', wellName: 'A1', volume: 50, flowRate: 92.86, wellLocation: { origin: 'bottom', offset: { z: 1 } } } },
			names
		);
		expect(line).toBe('Aspirate  50 µL  Slot 3 Wax Tube A1 Bottom +1 mm  92.9 µL/s');
	});
	it('reads bare-point moves, relative moves, homes and pauses', () => {
		expect(ot2CommandLine({ commandType: 'moveToCoordinates', params: { coordinates: { x: 120.46, y: 80, z: 40 }, forceDirect: true } })).toBe('Move To  X 120.5 Y 80 Z 40  Direct');
		expect(ot2CommandLine({ commandType: 'moveRelative', params: { axis: 'z', distance: -2.5 } })).toBe('Move Z -2.5 mm');
		expect(ot2CommandLine({ commandType: 'home', params: { axes: ['leftZ'] } })).toBe('Home Left Z');
		expect(ot2CommandLine({ commandType: 'home', params: {} })).toBe('Home All');
		expect(ot2CommandLine({ commandType: 'waitForResume', params: { message: 'ARM PARKED 2 ' } })).toBe('Pause  ARM PARKED 2');
		expect(ot2CommandLine({ commandType: 'waitForDuration', params: { seconds: 2 } })).toBe('Delay  2 s');
	});
	it('uses the legacy text of an old-API protocol and title-cases unknown commands', () => {
		expect(ot2CommandLine({ commandType: 'custom', params: { legacyCommandType: 'command.ASPIRATE', legacyCommandText: 'Aspirating 50.0 uL from A1' } })).toBe('Aspirating 50.0 uL from A1');
		expect(ot2CommandLine({ commandType: 'verifyTipPresence', params: { pipetteId: 'p1' } }, names)).toBe('Verify Tip Presence  p300_single_gen2 left');
	});
});

describe('pickLoggable', () => {
	const c = (status: string, at = '2026-11-06T18:00:00Z') => ({ commandType: 'aspirate', status, startedAt: at, completedAt: at });
	it('logs ended commands in order and stops at the first one still going', () => {
		const r = pickLoggable([c('succeeded'), c('failed'), c('running'), c('succeeded')], 10, 'running');
		expect(r.rows.map((x) => x.seq)).toEqual([10, 11]);
		expect(r.cursor).toBe(12);
		expect(r.blocked).toBe(true);
	});
	it('skips commands an ended run never ran', () => {
		const r = pickLoggable([c('succeeded'), { commandType: 'home', status: 'queued' }], 0, 'stopped');
		expect(r.rows.map((x) => x.seq)).toEqual([0]);
		expect(r.cursor).toBe(2);
		expect(r.blocked).toBe(false);
	});
});

describe('timing', () => {
	it('takes start, end and milliseconds from the command', () => {
		const t = commandTiming({ commandType: 'aspirate', startedAt: '2026-11-06T18:00:00.000Z', completedAt: '2026-11-06T18:00:01.250Z' });
		expect(t?.durationMs).toBe(1250);
		expect(commandTiming({ commandType: 'aspirate' })).toBeNull();
	});
	it('sums only rows with a measured end, arm first', () => {
		const end = '2026-11-06T18:00:10Z';
		const rows = summarizeTiming([
			{ device: 'ot2', kind: 'aspirate', durationMs: 1000, endAt: end },
			{ device: 'ot2', kind: 'aspirate', durationMs: 3000, endAt: end },
			{ device: 'ot2', kind: 'home', durationMs: 9000, endAt: end },
			{ device: null, kind: 'loop_step', durationMs: 41000, endAt: end },
			{ device: 'arm', kind: 'move', durationMs: 120, endAt: null }
		]);
		expect(rows.map((r) => `${r.device} ${r.kind} ${r.count} ${r.totalS} ${r.avgS}`)).toEqual(['arm loop_step 1 41 41', 'ot2 home 1 9 9', 'ot2 aspirate 2 4 2']);
	});
	it('keeps OT-2 rows out of the servo summary', () => {
		const s = summarizeServoMoves([{ device: 'ot2', kind: 'moveToWell', servo: null, goal: null, delta: null, goals: { '2': 100 }, at: '2026-11-06T18:00:00Z' }]);
		expect(s.find((x) => x.servo === 2)?.moves).toBe(0);
	});
});

describe('titles', () => {
	it('title-cases OT-2 kinds and names loop steps', () => {
		expect(camelTitle('moveToAddressableAreaForDropTip')).toBe('Move To Addressable Area For Drop Tip');
		expect(kindTitle('dispenseInPlace')).toBe('Dispense In Place');
		expect(kindTitle('loop_step')).toBe('Loop Step');
		expect(loopStepLine('withdraw_grab', 1, 38, 'withdraw + grab')).toBe('Withdraw + Grab Cart 1 To 2  withdraw + grab  Planned 38.0 s');
	});
});

describe('onPiClock', () => {
	it("moves the robot's times onto the Pi's clock by the measured offset", async () => {
		const { onPiClock } = await import('./ot2-move-log');
		const t = { at: new Date('2026-11-06T18:00:01.500Z'), endAt: new Date('2026-11-06T18:00:02.000Z'), durationMs: 500 };
		const s = onPiClock(t, 1500);
		expect(s.at.toISOString()).toBe('2026-11-06T18:00:00.000Z');
		expect(s.endAt?.toISOString()).toBe('2026-11-06T18:00:00.500Z');
		expect(s.durationMs).toBe(500);
		expect(onPiClock(t, null)).toBe(t);
	});
});
