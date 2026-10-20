import { describe, expect, it } from 'vitest';
import { assessHome, planJogDeltas, residuals, HOME_STEP_TOLERANCE } from './home-calibration';
import type { VisionAssessment } from './apriltags';

const home = { '1': 2048, '2': 1500, '3': 2600, '4': 2048, '5': 2100 };

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
