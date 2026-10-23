import { describe, expect, it } from 'vitest';
import {
	advanceCursor,
	assessStep,
	cleanStepTolerances,
	cleanToleranceOverride,
	describeStep,
	effectiveTolerances,
	jointStepsFrom,
	nearPose,
	planChunks,
	stepResiduals,
	verifyWanted,
	worstOffset,
	DEFAULT_STEP_TOLERANCES
} from './verified-poses';
import type { TagAssessment, VisionAssessment } from './apriltags';

function tag(role: 'arm' | 'fixed', status: TagAssessment['status']): TagAssessment {
	return {
		markerId: 'm',
		tagId: 1,
		name: 'tag',
		group: null,
		role,
		status,
		over: [],
		offMm: status === 'moved' ? 9 : 0.4,
		offDeg: 0.2,
		offTiltDeg: null,
		ambiguous: false,
		flipped: false,
		offPx: null,
		center: status === 'missing' ? null : [0.5, 0.5],
		corners: null,
		zMm: 300,
		depthMm: null,
		offDepthMm: null,
		zSource: 'image',
		imageZMm: 300
	};
}

function vision(verdict: VisionAssessment['verdict'], markers: TagAssessment[]): VisionAssessment {
	return { verdict, markers, okCount: markers.filter((m) => m.status === 'ok').length, movedCount: markers.filter((m) => m.status === 'moved').length, missingCount: markers.filter((m) => m.status === 'missing').length, cameraShift: null, extraTagIds: [] };
}

describe('tolerances', () => {
	it('fills blanks from the fallback and rounds', () => {
		expect(cleanStepTolerances({})).toEqual(DEFAULT_STEP_TOLERANCES);
		expect(cleanStepTolerances({ positionMm: '2.55', angleDeg: '', steps: 20 })).toEqual({ positionMm: 2.6, angleDeg: 5, steps: 20 });
	});
	it('refuses out-of-range values with a reason', () => {
		expect(() => cleanStepTolerances({ positionMm: 0 })).toThrow(/Position tolerance/);
		expect(() => cleanStepTolerances({ angleDeg: 91 })).toThrow(/Angle tolerance/);
		expect(() => cleanStepTolerances({ steps: 2.5 })).toThrow(/Encoder tolerance/);
		expect(() => cleanStepTolerances({ steps: 0 })).toThrow(/Encoder tolerance/);
	});
	it('an override keeps only the fields it sets', () => {
		expect(cleanToleranceOverride(null)).toBeNull();
		expect(cleanToleranceOverride({})).toBeNull();
		expect(cleanToleranceOverride({ positionMm: '', angleDeg: null, steps: '' })).toBeNull();
		expect(cleanToleranceOverride({ positionMm: 3 })).toEqual({ positionMm: 3 });
		expect(cleanToleranceOverride({ positionMm: 3, steps: '25' })).toEqual({ positionMm: 3, steps: 25 });
		expect(() => cleanToleranceOverride({ steps: 999 })).toThrow(/Encoder tolerance/);
	});
	it('effective = base with the override on top', () => {
		const base = { positionMm: 5, angleDeg: 5, steps: 15 };
		expect(effectiveTolerances(base, null)).toEqual(base);
		expect(effectiveTolerances(base, { angleDeg: 0 })).toEqual({ positionMm: 5, angleDeg: 0, steps: 15 });
		expect(effectiveTolerances(base, { positionMm: 2, steps: 40 })).toEqual({ positionMm: 2, angleDeg: 5, steps: 40 });
	});
});

describe('which steps are verified', () => {
	it('auto follows whether the pose has a reference; explicit wins', () => {
		expect(verifyWanted(undefined, true)).toBe(true);
		expect(verifyWanted(null, false)).toBe(false);
		expect(verifyWanted(true, false)).toBe(true);
		expect(verifyWanted(false, true)).toBe(false);
	});
	it('chunks end at every verified step and at the end', () => {
		expect(planChunks([])).toEqual([]);
		expect(planChunks([false, false, false])).toEqual([{ from: 0, to: 2, verifyStep: null }]);
		expect(planChunks([true, true])).toEqual([
			{ from: 0, to: 0, verifyStep: 0 },
			{ from: 1, to: 1, verifyStep: 1 }
		]);
		expect(planChunks([false, true, false, false, true, false])).toEqual([
			{ from: 0, to: 1, verifyStep: 1 },
			{ from: 2, to: 4, verifyStep: 4 },
			{ from: 5, to: 5, verifyStep: null }
		]);
		// A verified last step is its own check, not a trailing unverified chunk.
		expect(planChunks([false, true])).toEqual([{ from: 0, to: 1, verifyStep: 1 }]);
	});
	it('the cursor walks the chunks and stops at done', () => {
		expect(advanceCursor({ chunk: 0, phase: 'verify' }, 3)).toEqual({ chunk: 1, phase: 'play' });
		expect(advanceCursor({ chunk: 2, phase: 'verify' }, 3)).toEqual({ chunk: 2, phase: 'done' });
		expect(advanceCursor({ chunk: 0, phase: 'playing' }, 1)).toEqual({ chunk: 0, phase: 'done' });
	});
});

describe('is the arm on the pose', () => {
	const goals = [2048, 1500, 2600, 2000, 2048, 1800];
	it('judges servos 1–5 only, by the worst joint', () => {
		expect(worstOffset([2048, 1480, 2600, 2000, 2048, 900], goals)).toBe(20);
		expect(nearPose([2048, 1480, 2600, 2000, 2048, 900], goals)).toBe(true);
		expect(nearPose([2048, 1400, 2600, 2000, 2048, 1800], goals)).toBe(false);
		expect(nearPose([2048, 1400, 2600, 2000, 2048, 1800], goals, 100)).toBe(true);
	});
	it('a missing reading is infinitely far', () => {
		expect(worstOffset([2048, NaN, 2600, 2000, 2048, 1800], goals)).toBe(Number.POSITIVE_INFINITY);
	});
	it('servo-keyed steps from a positions list', () => {
		expect(jointStepsFrom(goals)).toEqual({ '1': 2048, '2': 1500, '3': 2600, '4': 2000, '5': 2048 });
	});
});

describe('the per-step verdict', () => {
	const ref = jointStepsFrom([2048, 1500, 2600, 2000, 2048, 1800]);
	const tol = { positionMm: 5, angleDeg: 5, steps: 15 };
	it('passes only when both sides agree', () => {
		const r = stepResiduals(jointStepsFrom([2050, 1490, 2605, 2000, 2048, 0]), ref, tol);
		expect(r.off).toEqual([]);
		const a = assessStep(r, vision('ok', [tag('arm', 'ok'), tag('fixed', 'ok')]));
		expect(a).toMatchObject({ verdict: 'ok', passed: true, landed: true, tagsOk: true, residualMax: 10 });
	});
	it('encoders off → position_off, with the step tolerance deciding', () => {
		const r = stepResiduals(jointStepsFrom([2048, 1470, 2600, 2000, 2048, 0]), ref, tol);
		expect(r.off).toEqual([2]);
		expect(assessStep(r, vision('ok', [tag('arm', 'ok')])).verdict).toBe('position_off');
		const wide = stepResiduals(jointStepsFrom([2048, 1470, 2600, 2000, 2048, 0]), ref, { ...tol, steps: 40 });
		expect(assessStep(wide, vision('ok', [tag('arm', 'ok')])).verdict).toBe('ok');
	});
	it('tags off, both off, camera moved', () => {
		const ok = stepResiduals(ref, ref, tol);
		expect(assessStep(ok, vision('off', [tag('arm', 'moved')])).verdict).toBe('tags_off');
		const bad = stepResiduals(jointStepsFrom([2048, 1400, 2600, 2000, 2048, 0]), ref, tol);
		expect(assessStep(bad, vision('off', [tag('arm', 'moved')])).verdict).toBe('position_off_and_tags_off');
		expect(assessStep(ok, vision('camera_moved', [])).verdict).toBe('camera_moved');
	});
	it('a missing side is never a pass', () => {
		const ok = stepResiduals(ref, ref, tol);
		expect(assessStep(null, vision('ok', [tag('arm', 'ok')]))).toMatchObject({ verdict: 'unverified', passed: false, landed: null });
		expect(assessStep(ok, null)).toMatchObject({ verdict: 'unverified', passed: false, tagsOk: null });
		// Only fixed tags tracked: says nothing about the arm.
		expect(assessStep(ok, vision('ok', [tag('fixed', 'ok')])).verdict).toBe('unverified');
		// The arm tag was calibrated but is not found now: 'off' from assessTags → tags_off, not a silent pass.
		expect(assessStep(ok, vision('off', [tag('arm', 'missing'), tag('fixed', 'ok')])).verdict).toBe('tags_off');
	});
	it('describes each verdict with the numbers', () => {
		const r = stepResiduals(jointStepsFrom([2048, 1470, 2600, 2000, 2048, 0]), ref, tol);
		const a = assessStep(r, vision('ok', [tag('arm', 'ok')]));
		expect(describeStep('Over tray', a, r, 'All 1 tags are at their home positions.', tol)).toMatch(/did not land: joint\(s\) 2 are 30 step\(s\) from the reference \(limit 15\)/);
		const okR = stepResiduals(ref, ref, tol);
		expect(describeStep('Over tray', assessStep(okR, vision('ok', [tag('arm', 'ok')])), okR, null, tol)).toMatch(/verified: encoders within 0 step/);
		expect(describeStep('Over tray', assessStep(okR, null), okR, null, tol)).toMatch(/could not be verified: the camera check did not run/);
	});
});
