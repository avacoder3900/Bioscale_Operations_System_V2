import { describe, expect, it } from 'vitest';
import { describeArmMove, FIRE_KINDS, frameStats, goalsById, moveLine, playFramesFromJsonl, summarizeServoMoves } from './move-log';

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
	it('reads and settings are not movements', () => {
		expect(describeArmMove('GET', '/servos', null, [])).toBeNull();
		expect(describeArmMove('GET', '/gpio/status', null, {})).toBeNull();
		expect(describeArmMove('POST', '/servos/gains', {}, null)).toBeNull();
		expect(describeArmMove('POST', '/cameras/top/controls', {}, null)).toBeNull();
	});
});

describe('Conveyor Belt and Trapdoor Solenoid fires', () => {
	it('each fire is a row naming what fired and for how long', () => {
		expect(describeArmMove('POST', '/gpio/pulse', { pin: 17, ms: 100 }, null)).toMatchObject({ kind: 'fire', what: 'Solenoid A 100 ms' });
		expect(describeArmMove('POST', '/gpio/sequence', { pins: [17, 27], ms: 100, gap_ms: 500 }, null)?.what).toBe('Solenoid A, Solenoid B 100 ms, Gap 500 ms');
		expect(describeArmMove('POST', '/conveyor/pulse', { ms: 600, delay_ms: 0 }, null)).toMatchObject({ kind: 'conveyor', what: '600 ms' });
		expect(describeArmMove('POST', '/conveyor/pulse', { ms: 600, delay_ms: 250 }, null)?.what).toBe('600 ms After 250 ms');
		expect(describeArmMove('POST', '/conveyor/stop', undefined, null)?.kind).toBe('conveyor_stop');
		expect(describeArmMove('POST', '/conveyor/off', undefined, null)?.what).toBe('Force Off');
		expect(describeArmMove('POST', '/fires/stop', undefined, null)?.kind).toBe('fires_stop');
	});
	it('a fires-only play lists its fires', () => {
		const e = describeArmMove('POST', '/fires/play', { title: 'Drop', fires: [{ t: 0, pin: 22, ms: 600 }, { t: 0.7, pin: 27, ms: 100 }] }, null);
		expect(e?.kind).toBe('fires_play');
		expect(e?.what).toBe('Drop  Conveyor Belt 600 ms At 0 s, Solenoid B 100 ms At 0.7 s');
	});
	it('fires are their own kinds (no servo readings around them)', () => {
		for (const k of ['fire', 'fire_sequence', 'conveyor', 'conveyor_stop', 'fires_play', 'fires_stop']) expect(FIRE_KINDS.has(k)).toBe(true);
		expect(FIRE_KINDS.has('play')).toBe(false);
	});
});

describe('play frames', () => {
	const jsonl = [
		JSON.stringify({ event: 'header', rate_hz: 30, joint_names: [] }),
		JSON.stringify({ event: 'frame', t: 0, goal: [2000, 1000, 3000, 900, 550, 2100] }),
		JSON.stringify({ event: 'frame', t: 0.0333, goal: [2010, 1000, 2990, 900, 550, 2100], fire: { pin: 17, ms: 100, solenoid: 'A' } }),
		JSON.stringify({ event: 'frame', t: 0.0667, goal: [2020, 1000, 2980, 901, 550, 2100] }),
		JSON.stringify({ event: 'footer', duration_s: 0.0667, frames: 3 })
	].join('\n');
	it('reads every frame, its time and each servo goal, and the fires', () => {
		const f = playFramesFromJsonl(jsonl)!;
		expect(f.rateHz).toBe(30);
		expect(f.t).toEqual([0, 0.033, 0.067]);
		expect(f.goals[2]).toEqual([2020, 1000, 2980, 901, 550, 2100]);
		expect(f.fires).toEqual([{ t: 0.033, pin: 17, ms: 100, label: 'Solenoid A' }]);
	});
	it('the older positions{} format, and junk lines skipped', () => {
		const f = playFramesFromJsonl('not json\n{"t":0,"positions":{"1":5,"3":7}}\n')!;
		expect(f.goals[0]).toEqual([5, null, 7, null, null, null]);
		expect(playFramesFromJsonl('{"event":"header"}')).toBeNull();
	});
	it('direction changes inside a play, past a 3-step jitter', () => {
		const goals = [100, 110, 120, 119, 121, 130, 110, 90, 95, 80].map((v) => [v]);
		const s = frameStats({ rateHz: 30, t: goals.map((_, i) => i), goals, fires: [] })['1'];
		// Up to 130, down to 90, up to 95, down to 80: three turns. The 120 -> 119 wobble is not one.
		expect(s.reversals).toBe(3);
		expect([s.first, s.last, s.min, s.max, s.firstDir, s.lastDir]).toEqual([100, 80, 80, 130, 1, -1]);
	});
	it('the summary counts a play once per servo it moved, with its turns', () => {
		const fs = frameStats({ rateHz: 30, t: [0, 1, 2], goals: [[100, 50], [200, 50], [150, 50]], fires: [] });
		const rows = [
			{ kind: 'move', at: '2026-11-06T00:00:00Z', servo: 1, goal: 50, delta: null, goals: null },
			{ kind: 'play', at: '2026-11-06T00:00:01Z', servo: null, goal: null, delta: null, goals: null, frameStats: fs }
		];
		// Servo 1: the move, then the play (up, then down: one turn). Servo 2 never moved.
		expect(summarizeServoMoves(rows, 2)).toEqual([
			{ servo: 1, moves: 2, reversals: 1 },
			{ servo: 2, moves: 0, reversals: 0 }
		]);
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
