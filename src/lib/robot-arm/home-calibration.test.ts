import { describe, expect, it } from 'vitest';
import {
	assessHome,
	describeVerdict,
	imageSimilarity,
	planJogDeltas,
	residuals,
	signatureFromGrey,
	HOME_STEP_TOLERANCE,
	SIGNATURE_WIDTH,
	SIGNATURE_HEIGHT
} from './home-calibration';

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

function scene(f: (x: number, y: number) => number): number[] {
	const out: number[] = [];
	for (let y = 0; y < SIGNATURE_HEIGHT; y++) for (let x = 0; x < SIGNATURE_WIDTH; x++) out.push(f(x, y));
	return out;
}
// A bright "arm" blob on a dark gradient background, centred at (cx, cy).
const armAt = (cx: number, cy: number) =>
	scene((x, y) => (Math.hypot(x - cx, y - cy) < 5 ? 0.95 : 0.1 + 0.2 * (y / SIGNATURE_HEIGHT)));

describe('imageSimilarity', () => {
	it('identical scenes → 1; a brightness/exposure change still ≈ 1', () => {
		const a = armAt(16, 12);
		expect(imageSimilarity(a, a)).toBeCloseTo(1, 6);
		const brighter = a.map((v) => Math.min(1, v * 1.3 + 0.1));
		expect(imageSimilarity(a, brighter)).toBeGreaterThan(0.99);
	});
	it('the arm a few cells over scores clearly below the threshold; a flat frame scores 0', () => {
		expect(imageSimilarity(armAt(16, 12), armAt(24, 12))).toBeLessThan(0.7);
		expect(imageSimilarity(armAt(16, 12), new Array(SIGNATURE_WIDTH * SIGNATURE_HEIGHT).fill(0.5))).toBe(0);
		expect(imageSimilarity([1, 2], [1])).toBe(0);
	});
	it('signatureFromGrey scales bytes to [0,1] and insists on the thumbnail size', () => {
		const grey = new Uint8Array(SIGNATURE_WIDTH * SIGNATURE_HEIGHT).fill(255);
		expect(signatureFromGrey(grey).every((v) => v === 1)).toBe(true);
		expect(() => signatureFromGrey(new Uint8Array(10))).toThrow(/expects 768/);
	});
});

describe('assessHome + describeVerdict', () => {
	const ok = residuals(home, home);
	const off = residuals({ ...home, '2': 1400 }, home);
	it('home needs the encoders AND the camera (when there is one)', () => {
		expect(assessHome(ok, 0.97).verdict).toBe('home');
		expect(assessHome(ok, null)).toMatchObject({ verdict: 'home', cameraMatched: null });
		expect(assessHome(ok, 0.6).verdict).toBe('camera_mismatch');
		expect(assessHome(off, 0.97).verdict).toBe('position_off');
		expect(assessHome(off, 0.3).verdict).toBe('position_off_and_camera_mismatch');
	});
	it('threshold and tolerance are overridable', () => {
		expect(assessHome(ok, 0.6, { threshold: 0.5 }).verdict).toBe('home');
		expect(assessHome(off, 0.97, { tolerance: 200 }).verdict).toBe('home');
	});
	it('every verdict has a sentence that names the numbers', () => {
		expect(describeVerdict(assessHome(off, 0.3))).toMatch(/100 steps off and the camera disagrees \(camera match 30%\)/);
		expect(describeVerdict(assessHome(ok, 0.97))).toMatch(/within 0 steps \(camera match 97%\)/);
		expect(describeVerdict(assessHome(ok, 0.6))).toMatch(/recalibrate/);
		expect(describeVerdict(assessHome(off, null))).toMatch(/did not land/);
	});
});
