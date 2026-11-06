import { describe, expect, it } from 'vitest';
import { isSettled, readingLine, servoReadings, summarizeServoMoves } from './move-log';
import { ot2ActionOf } from './ot2-move-log';
import { groupOfKind } from './move-types';

const raw = [
	{ id: 1, name: 'shoulder_pan', position: 2049, speed: 0, load: 0, voltage: 12.6, temperature: 42, torque: true },
	{ id: 3, name: 'elbow_flex', position: 2975, speed: 0, load: -115, voltage: 12.4, temperature: 38, torque: true }
];

describe('servo readings', () => {
	it('keeps the fields the log needs from GET /servos', () => {
		expect(servoReadings(raw)?.[1]).toEqual({ id: 3, position: 2975, speed: 0, load: -115, voltage: 12.4, temperature: 38, torque: true });
		expect(servoReadings({ error: 'x' })).toBeNull();
		expect(servoReadings([])).toBeNull();
	});
	it('reads one servo with its goal and miss, or all servos', () => {
		const r = servoReadings(raw)!;
		expect(readingLine('before', r, { servo: 3 })).toBe('Before  Servo 3  Position 2975  38 °C  Load -115  12.4 V  Torque On');
		expect(readingLine('after', r, { servo: 3, goal: 2947, settledMs: 1200 })).toBe(
			'After  Servo 3  Position 2975  Goal 2947  Off 28  38 °C  Load -115  12.4 V  Torque On  Settled 1.2 s'
		);
		expect(readingLine('after', r, { note: 'Still Moving' })).toBe('After  1: 2049 42 °C  3: 2975 38 °C  Still Moving');
	});
	it('is settled only when the watched servos are still', () => {
		const a = servoReadings(raw)!;
		const moving = a.map((x) => (x.id === 3 ? { ...x, speed: 40, position: 2960 } : x));
		expect(isSettled(a, a, [3])).toBe(true);
		expect(isSettled(a, moving, [3])).toBe(false);
		expect(isSettled(a, moving, [1])).toBe(true);
		expect(isSettled(moving.map((x) => ({ ...x, speed: 0 })), a, [3])).toBe(false);
	});
	it('does not count readings as moves', () => {
		const s = summarizeServoMoves([
			{ kind: 'reading_before', servo: 3, goal: null, delta: null, goals: null, at: '2026-11-06T10:00:00Z' },
			{ kind: 'move', servo: 3, goal: 2947, delta: null, goals: null, at: '2026-11-06T10:00:01Z' }
		]);
		expect(s.find((x) => x.servo === 3)?.moves).toBe(1);
		expect(groupOfKind('arm', 'reading_after')?.title).toBe('Servo Reading');
	});
});

describe('OT-2 home and lights outside a run', () => {
	it('names home and lights, from an object or the direct line text', () => {
		expect(ot2ActionOf('POST', '/robot/home', { target: 'robot' })).toEqual({ kind: 'home', line: 'Home All' });
		expect(ot2ActionOf('POST', '/robot/home', '{"target":"pipette","mount":"left"}')).toEqual({ kind: 'home', line: 'Home  Left  Pipette' });
		expect(ot2ActionOf('POST', '/robot/lights', { on: true })).toEqual({ kind: 'lights_on', line: 'Rail Lights On' });
		expect(ot2ActionOf('POST', '/robot/lights', '{"on":false}')?.kind).toBe('lights_off');
		expect(ot2ActionOf('POST', '/robot/lights', undefined)).toEqual({ kind: 'lights', line: 'Rail Lights' });
		expect(groupOfKind('ot2', 'lights_on')?.title).toBe('Lights');
	});
	it('ignores reads and every other path', () => {
		expect(ot2ActionOf('GET', '/robot/lights', null)).toBeNull();
		expect(ot2ActionOf('POST', '/runs', {})).toBeNull();
	});
});
