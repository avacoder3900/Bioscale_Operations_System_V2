import { describe, expect, it } from 'vitest';
import {
	assessHome,
	baseOutOfRange,
	chunkJogPlan,
	degToSteps,
	planJogDeltas,
	residuals,
	shouldRetryHome,
	DEFAULT_HOMING,
	HOME_LOOP_MS,
	HOME_STEP_TOLERANCE,
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
		expect(shouldRetryHome({ ...base, verdict: 'home', residualMax: 3, clawClosed: false }).retry).toBe(true);
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
	it('stops when encoders are home and the claw closed but the tags disagree', () => {
		expect(shouldRetryHome({ ...base, verdict: 'markers_off', residualMax: 4, clawClosed: true }).reason).toBe('encoders are home; the tags disagree');
		expect(shouldRetryHome({ ...base, verdict: 'markers_off', residualMax: 4, clawClosed: false }).retry).toBe(true);
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
	const vision = (verdict: VisionAssessment['verdict']) => ({ verdict }) as VisionAssessment;

	it('home needs the encoders AND the markers, when both exist', () => {
		expect(assessHome(ok, vision('ok')).verdict).toBe('home');
		expect(assessHome(ok, vision('off')).verdict).toBe('markers_off');
		expect(assessHome(off, vision('ok')).verdict).toBe('position_off');
		expect(assessHome(off, vision('off')).verdict).toBe('position_off_and_markers_off');
	});
	it('either side alone decides when the other is absent', () => {
		expect(assessHome(null, vision('ok'))).toMatchObject({ verdict: 'home', landed: null, markersOk: true });
		expect(assessHome(off, null)).toMatchObject({ verdict: 'position_off', markersOk: null });
		expect(assessHome(ok, vision('no_markers'))).toMatchObject({ verdict: 'home', markersOk: null });
		expect(assessHome(null, null).verdict).toBe('unverified');
		expect(assessHome(null, vision('no_markers')).verdict).toBe('unverified');
	});
	it('a moved camera overrides everything', () => {
		expect(assessHome(ok, vision('camera_moved')).verdict).toBe('camera_moved');
		expect(assessHome(off, vision('camera_moved')).verdict).toBe('camera_moved');
	});
});
