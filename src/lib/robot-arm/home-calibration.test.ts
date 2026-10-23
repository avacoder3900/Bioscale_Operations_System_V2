import { describe, expect, it } from 'vitest';
import {
	assessHome,
	baseOutOfRange,
	chunkJogPlan,
	degToSteps,
	planJogDeltas,
	residuals,
	shouldRetryHome,
	strainedJoints,
	unsteadyJoints,
	DEFAULT_HOMING,
	HOME_LOOP_MS,
	HOME_STEP_TOLERANCE,
	SERVO_LOAD_HIGH,
	SERVO_LOAD_MARGIN,
	type ServoReading,
	LIFT_SERVO_ID,
	MAX_JOG_STEPS
} from './home-calibration';
import type { VisionAssessment } from './apriltags';

const home = { '1': 2048, '2': 1500, '3': 2600, '4': 2048, '5': 2100 };

describe('home sequence', () => {
	it('default servo-1 range is ±90° = ±1024 steps, mouth opens 300', () => {
		expect(DEFAULT_HOMING).toEqual({ baseRangeSteps: 1024, gripperOpenSteps: 300 });
		expect(degToSteps(45)).toBe(512);
	});

	it('servo 1 inside its range → null; outside either side → freeze with the offset', () => {
		expect(baseOutOfRange({ ...home, '1': 2048 + 1024 }, home, 1024)).toBeNull();
		expect(baseOutOfRange({ ...home, '1': 2048 - 1025 }, home, 1024)).toEqual({ sid: 1, offSteps: -1025, limitSteps: 1024 });
		expect(baseOutOfRange({ ...home, '1': 2048 + 1500 }, home, 1024)?.offSteps).toBe(1500);
	});

	it('a missing servo-1 reading freezes rather than guessing', () => {
		expect(baseOutOfRange({ ...home, '1': undefined as any }, home, 1024)).not.toBeNull();
	});

	it('servo B alone can be planned first', () => {
		const cur = { ...home, '1': 2300, '2': 1100 };
		expect(planJogDeltas(cur, home, HOME_STEP_TOLERANCE, [LIFT_SERVO_ID])).toEqual([{ sid: 2, delta: 400 }]);
	});
});

describe('shouldRetryHome', () => {
	const base = { elapsedMs: 10_000, residualMax: 200, clawClosed: false };
	it('done only when home AND the claw is closed', () => {
		expect(shouldRetryHome({ ...base, verdict: 'home', residualMax: 3, clawClosed: true })).toEqual({ retry: false, reason: 'home, claw closed' });
		// Home with the claw open: within the first 5 s another attempt closes it; after that the page closes it (see below).
		expect(shouldRetryHome({ ...base, verdict: 'home', residualMax: 3, clawClosed: false, elapsedMs: 2_000 }).retry).toBe(true);
		// No claw reading at all: the claw is not required.
		expect(shouldRetryHome({ ...base, verdict: 'home', residualMax: 3, clawClosed: null }).retry).toBe(false);
	});
	it('stops on freeze, moved camera and the 90 s limit', () => {
		expect(shouldRetryHome({ ...base, verdict: 'frozen' }).retry).toBe(false);
		expect(shouldRetryHome({ ...base, verdict: 'camera_moved' }).retry).toBe(false);
		expect(shouldRetryHome({ ...base, verdict: 'position_off', elapsedMs: HOME_LOOP_MS })).toEqual({ retry: false, reason: 'timed out' });
	});
	it('keeps going while not home, however slowly — no jog or progress limit', () => {
		expect(shouldRetryHome({ ...base, verdict: 'position_off' }).retry).toBe(true);
		expect(shouldRetryHome({ ...base, verdict: 'position_off', residualMax: 199 }).retry).toBe(true);
	});
	it('close enough for long enough: stops jogging so the claw can close (2026-10-23)', () => {
		// 25 steps off (> HOME_STEP_TOLERANCE, < CLAW_CLOSE_TOLERANCE) after 5 s: stop, close the claw.
		const r = shouldRetryHome({ ...base, verdict: 'position_off', residualMax: 25, clawClosed: false, elapsedMs: 5_000 });
		expect(r.retry).toBe(false);
		expect(r.reason).toBe('encoders within 25 step(s) of home after 5 s — closing the claw');
		// Same, claw already closed: just stop.
		expect(shouldRetryHome({ ...base, verdict: 'position_off', residualMax: 25, clawClosed: true, elapsedMs: 6_000 }).reason).toBe('encoders within 25 step(s) of home after 6 s');
		// Not yet 5 s, or too far off: keep going.
		expect(shouldRetryHome({ ...base, verdict: 'position_off', residualMax: 25, clawClosed: false, elapsedMs: 4_900 }).retry).toBe(true);
		expect(shouldRetryHome({ ...base, verdict: 'position_off', residualMax: 41, clawClosed: false, elapsedMs: 30_000 }).retry).toBe(true);
		// Home verdict with the claw still open after 5 s: stop and let the page close it.
		expect(shouldRetryHome({ ...base, verdict: 'home', residualMax: 3, clawClosed: false, elapsedMs: 5_000 }).retry).toBe(false);
		// Overrides.
		expect(shouldRetryHome({ ...base, verdict: 'position_off', residualMax: 25, clawClosed: false, elapsedMs: 1_000, clawAfterMs: 1_000 }).retry).toBe(false);
		expect(shouldRetryHome({ ...base, verdict: 'position_off', residualMax: 25, clawClosed: false, elapsedMs: 9_000, clawToleranceSteps: 20 }).retry).toBe(true);
	});
	it('stops when encoders are home and the claw closed but the tags disagree', () => {
		expect(shouldRetryHome({ ...base, verdict: 'markers_off', residualMax: 4, clawClosed: true }).reason).toBe('encoders are home; the tags disagree');
		// Claw still open within the first 5 s: another attempt closes it; after 5 s the page does (see 'close enough').
		expect(shouldRetryHome({ ...base, verdict: 'markers_off', residualMax: 4, clawClosed: false, elapsedMs: 2_000 }).retry).toBe(true);
	});
});

describe('chunkJogPlan', () => {
	it('splits a big move into jogs the Pi accepts (≤300), keeping joint order and sign', () => {
		expect(chunkJogPlan([{ sid: 1, delta: -1185 }, { sid: 3, delta: 40 }, { sid: 4, delta: 600 }])).toEqual([
			{ sid: 1, delta: -300 },
			{ sid: 1, delta: -300 },
			{ sid: 1, delta: -300 },
			{ sid: 1, delta: -285 },
			{ sid: 3, delta: 40 },
			{ sid: 4, delta: 300 },
			{ sid: 4, delta: 300 }
		]);
	});
	it('every chunk is within the cap and they sum to the delta', () => {
		const c = chunkJogPlan([{ sid: 2, delta: 1777 }]);
		expect(c.every((s) => Math.abs(s.delta) <= MAX_JOG_STEPS)).toBe(true);
		expect(c.reduce((n, s) => n + s.delta, 0)).toBe(1777);
		expect(chunkJogPlan([])).toEqual([]);
	});
});

describe('planJogDeltas', () => {
	it('one delta per joint that is outside the tolerance, target − current', () => {
		const cur = { '1': 2048, '2': 1400, '3': 2650, '4': 2048 + HOME_STEP_TOLERANCE, '5': 1900 };
		expect(planJogDeltas(cur, home)).toEqual([
			{ sid: 2, delta: 100 },
			{ sid: 3, delta: -50 },
			{ sid: 5, delta: 200 }
		]);
	});
	it('already home → empty plan; a missing joint on either side throws (no partial moves)', () => {
		expect(planJogDeltas(home, home)).toEqual([]);
		expect(() => planJogDeltas({ ...home, '3': undefined as any }, home)).toThrow(/servo 3: no current/);
		expect(() => planJogDeltas(home, { ...home, '5': Number.NaN })).toThrow(/servo 5: no taught/);
	});
	it('ignores the gripper (servo 6)', () => {
		expect(planJogDeltas({ ...home, '6': 0 }, { ...home, '6': 4000 })).toEqual([]);
	});
});

describe('residuals', () => {
	it('reports per-joint error, the worst, and which joints are off', () => {
		const r = residuals({ ...home, '2': 1480, '4': 2000 }, home);
		expect(r.perJoint).toEqual({ '1': 0, '2': 20, '3': 0, '4': 48, '5': 0 });
		expect(r.max).toBe(48);
		expect(r.off).toEqual([2, 4]);
	});
	it('a joint with no reading is infinitely off', () => {
		const r = residuals({ '1': 2048 }, home);
		expect(r.max).toBe(Number.POSITIVE_INFINITY);
		expect(r.off).toEqual([2, 3, 4, 5]);
	});
});

describe('assessHome', () => {
	const ok = residuals(home, home);
	const off = residuals({ ...home, '2': 1400 }, home);
	const vision = (verdict: VisionAssessment['verdict'], roles: ('arm' | 'fixed')[] = ['arm', 'fixed']) =>
		({ verdict, markers: roles.map((role) => ({ role })) }) as VisionAssessment;

	it('home needs the encoders AND the tags', () => {
		expect(assessHome(ok, vision('ok')).verdict).toBe('home');
		expect(assessHome(ok, vision('off')).verdict).toBe('markers_off');
		expect(assessHome(off, vision('ok')).verdict).toBe('position_off');
		expect(assessHome(off, vision('off')).verdict).toBe('position_off_and_markers_off');
	});
	it('one side alone is never home: a missing side gives unverified, a failing side still reports', () => {
		expect(assessHome(null, vision('ok'))).toMatchObject({ verdict: 'unverified', landed: null, markersOk: true });
		expect(assessHome(ok, null)).toMatchObject({ verdict: 'unverified', landed: true, markersOk: null });
		expect(assessHome(ok, vision('no_markers'))).toMatchObject({ verdict: 'unverified', markersOk: null });
		expect(assessHome(off, null)).toMatchObject({ verdict: 'position_off', markersOk: null });
		expect(assessHome(null, vision('off')).verdict).toBe('markers_off');
		expect(assessHome(null, null).verdict).toBe('unverified');
	});
	it('fixed tags alone say nothing about the arm', () => {
		expect(assessHome(ok, vision('ok', ['fixed']))).toMatchObject({ verdict: 'unverified', markersOk: null });
		expect(assessHome(ok, vision('off', ['fixed'])).verdict).toBe('markers_off');
	});
	it('a moved camera overrides everything', () => {
		expect(assessHome(ok, vision('camera_moved')).verdict).toBe('camera_moved');
		expect(assessHome(off, vision('camera_moved')).verdict).toBe('camera_moved');
	});
	it('carries strained joints through without changing the verdict', () => {
		const s = [{ sid: 2, load: 800, temperatureC: 40, reason: 'high_load' as const }];
		expect(assessHome(off, vision('ok'), s)).toMatchObject({ verdict: 'position_off', strained: s });
		expect(assessHome(ok, vision('ok')).strained).toEqual([]);
	});
});

describe('strainedJoints', () => {
	const reading = (sid: number, load: number | null, temperatureC: number | null = 35): ServoReading => ({
		sid,
		steps: 2048,
		load,
		temperatureC,
		voltage: 12.3,
		torque: true
	});

	it('flags high load and hot servos on the home joints only', () => {
		const now = [reading(1, 50), reading(2, -SERVO_LOAD_HIGH), reading(3, 100, 60), reading(6, 990)];
		expect(strainedJoints(now)).toEqual([
			{ sid: 2, load: -SERVO_LOAD_HIGH, temperatureC: 35, reason: 'high_load' },
			{ sid: 3, load: 100, temperatureC: 60, reason: 'hot' }
		]);
	});
	it('a joint that already carried that load at home is not strained', () => {
		const baseline = [reading(2, 640)];
		expect(strainedJoints([reading(2, 700)], baseline)).toEqual([]);
		expect(strainedJoints([reading(2, 640 + SERVO_LOAD_MARGIN)], baseline)).toHaveLength(1);
	});
	it('no telemetry → nothing flagged', () => {
		expect(strainedJoints([reading(2, null, null)])).toEqual([]);
	});
});

describe('unsteadyJoints', () => {
	it('joints that moved past the tolerance between two reads, or are missing', () => {
		expect(unsteadyJoints(home, home)).toEqual([]);
		expect(unsteadyJoints(home, { ...home, '2': 1500 + HOME_STEP_TOLERANCE })).toEqual([]);
		expect(unsteadyJoints(home, { ...home, '2': 1500 + HOME_STEP_TOLERANCE + 1, '5': undefined as any })).toEqual([2, 5]);
	});
});

describe('shouldRetryHome: unverified with encoders home', () => {
	it('stops — more jogs would not make the camera confirm', () => {
		const r = shouldRetryHome({ verdict: 'unverified', elapsedMs: 1000, residualMax: 3, clawClosed: true });
		expect(r.retry).toBe(false);
		expect(r.reason).toContain('could not confirm');
	});
});
