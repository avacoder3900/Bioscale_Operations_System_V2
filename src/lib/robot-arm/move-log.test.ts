import { describe, expect, it } from 'vitest';
import { describeArmMove, goalsById, moveLine, summarizeServoMoves } from './move-log';

describe('describeArmMove', () => {
	it('a slider move is one servo with its goal', () => {
		expect(describeArmMove('POST', '/servos/2/move', { position: 2048 }, { id: 2, goal: 2048 })).toEqual({
			kind: 'move',
			servo: 2,
			goal: 2048,
			delta: null,
			goals: null,
			what: null
		});
	});
	it('a jog keeps the delta and the goal the Pi set', () => {
		const e = describeArmMove('POST', '/servos/3/jog', { delta_steps: -40 }, { id: 3, goal: 1990 });
		expect([e?.kind, e?.servo, e?.delta, e?.goal]).toEqual(['jog', 3, -40, 1990]);
	});
	it('a failed move (no answer) still keeps what was asked', () => {
		expect(describeArmMove('POST', '/servos/1/move', { position: 1500 }, null)?.goal).toBe(1500);
	});
	it('whole-arm commands', () => {
		expect(describeArmMove('POST', '/servos/hold', null, { held: true, positions: { '1': 2000, '2': 2100 } })?.goals).toEqual({ '1': 2000, '2': 2100 });
		expect(describeArmMove('POST', '/torque', { enable: false }, null)?.kind).toBe('torque_off');
		expect(describeArmMove('POST', '/torque', { enable: true }, null)?.kind).toBe('torque_on');
		expect(describeArmMove('POST', '/replay/start', { source: 'pick_a.jsonl', loops: 1 }, null)?.what).toBe('pick_a.jsonl');
		expect(describeArmMove('POST', '/replay/start', { source: 'pick_a.jsonl', loops: 3 }, null)?.what).toBe('pick_a.jsonl x3');
		expect(describeArmMove('POST', '/tasks/wax%20fill/run', {}, null)?.what).toBe('wax fill');
		expect(describeArmMove('POST', '/sessions/stop', undefined, null)?.kind).toBe('stop');
		expect(describeArmMove('POST', '/teleop/start', { rate_hz: 30 }, null)?.kind).toBe('leader');
	});
	it('a Cartesian jog keys goals by servo id even when the Pi uses joint names', () => {
		const e = describeArmMove('POST', '/jog/cartesian', { dx_mm: 5, dy_mm: 0, dz_mm: -2 }, { goal_steps: { shoulder_pan: 2010, elbow_flex: 1800 } });
		expect(e?.goals).toEqual({ '1': 2010, '3': 1800 });
		expect(e?.what).toBe('dx 5 dy 0 dz -2 mm');
	});
	it('reads and non-arm commands are not movements', () => {
		expect(describeArmMove('GET', '/servos', null, [])).toBeNull();
		expect(describeArmMove('POST', '/gpio/pulse', { pin: 17, ms: 100 }, null)).toBeNull();
		expect(describeArmMove('POST', '/conveyor/pulse', { ms: 600 }, null)).toBeNull();
		expect(describeArmMove('POST', '/servos/gains', {}, null)).toBeNull();
		expect(describeArmMove('POST', '/cameras/top/controls', {}, null)).toBeNull();
	});
});

describe('goalsById', () => {
	it('drops keys it cannot place and non-numbers', () => {
		expect(goalsById({ '1': 10, wrist_roll: 20, bogus: 30, '2': 'x' })).toEqual({ '1': 10, '5': 20 });
		expect(goalsById(null)).toBeNull();
		expect(goalsById({})).toBeNull();
	});
});

describe('moveLine', () => {
	it('servo rows', () => {
		expect(moveLine({ kind: 'move', servo: 2, goal: 2048, delta: null, goals: null, what: null })).toBe('Servo 2 -> 2048');
		expect(moveLine({ kind: 'jog', servo: 3, goal: 1990, delta: 40, goals: null, what: null })).toBe('Servo 3 +40 -> 1990');
		expect(moveLine({ kind: 'jog', servo: 3, goal: null, delta: -40, goals: null, what: null })).toBe('Servo 3 -40');
	});
	it('whole-arm rows', () => {
		expect(moveLine({ kind: 'play', servo: null, goal: null, delta: null, goals: null, what: 'pick_a' })).toBe('Play  pick_a');
		expect(moveLine({ kind: 'hold', servo: null, goal: null, delta: null, goals: { '1': 5, '2': 6 }, what: null })).toBe('Hold  1: 5  2: 6');
		expect(moveLine({ kind: 'stop', servo: null, goal: null, delta: null, goals: null, what: null })).toBe('Stop');
	});
});

describe('summarizeServoMoves', () => {
	const at = (s: number) => new Date(Date.UTC(2026, 10, 6, 12, 0, s)).toISOString();
	const mv = (s: number, servo: number, goal: number, ok = true) => ({ at: at(s), kind: 'move' as const, servo, goal, delta: null, goals: null, ok });
	it('counts moves and back-and-forth per servo, in time order', () => {
		// Out of order on purpose: 2000 -> 2100 -> 2000 -> 2100 is two reversals.
		const rows = [mv(3, 2, 2100), mv(0, 2, 2000), mv(1, 2, 2100), mv(2, 2, 2000), mv(4, 1, 1000)];
		const s = summarizeServoMoves(rows);
		expect(s.find((x) => x.servo === 2)).toEqual({ servo: 2, moves: 4, reversals: 2 });
		expect(s.find((x) => x.servo === 1)).toEqual({ servo: 1, moves: 1, reversals: 0 });
		expect(s).toHaveLength(6);
	});
	it('a steady one-way sweep has no reversals; failed rows are ignored', () => {
		const rows = [mv(0, 4, 100), mv(1, 4, 200), mv(2, 4, 300), mv(3, 4, 100, false), mv(4, 4, 400)];
		expect(summarizeServoMoves(rows).find((x) => x.servo === 4)).toEqual({ servo: 4, moves: 4, reversals: 0 });
	});
	it('jogs reverse by their sign; a Hold sets the position without counting', () => {
		const jog = (s: number, delta: number) => ({ at: at(s), kind: 'jog' as const, servo: 5, goal: null, delta, goals: null });
		const hold = { at: at(2), kind: 'hold' as const, servo: null, goal: null, delta: null, goals: { '5': 900 } };
		const rows = [jog(0, 20), jog(1, -20), hold, { ...mv(3, 5, 950) }];
		expect(summarizeServoMoves(rows).find((x) => x.servo === 5)).toEqual({ servo: 5, moves: 3, reversals: 2 });
	});
});
