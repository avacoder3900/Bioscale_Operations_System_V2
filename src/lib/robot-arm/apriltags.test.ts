import { describe, expect, it } from 'vitest';
import {
	assessTags,
	axisAngle,
	compose,
	describeVision,
	estimateCameraShift,
	invert,
	isAmbiguous,
	matMul,
	minTagSizeMm,
	resolvePose,
	rotationAngleDeg,
	splitRotationDeg,
	sheetSizeMm,
	DEFAULT_TOLERANCES,
	IDENTITY,
	type CalibratedTag,
	type Rigid,
	type TagDetection,
	type TagRole,
	type Vec3
} from './apriltags';

const I = IDENTITY.R;

function cal(tagId: number, role: TagRole, t: Vec3, R = I): CalibratedTag {
	return {
		markerId: `m${tagId}`,
		tagId,
		name: `Tag ${tagId}`,
		group: null,
		role,
		sizeMm: 30,
		center: [0.5, 0.5],
		corners: [],
		pose: { t, R, reprojPx: 0.2 },
		depthMm: null
	};
}

/** What the camera sees of a calibrated tag after the world/camera moved by `M`. */
function seen(c: CalibratedTag, M: Rigid = IDENTITY, extra: Rigid = IDENTITY): TagDetection {
	const p = compose(M, compose(extra, { R: c.pose!.R, t: c.pose!.t }));
	return { id: c.tagId, center: c.center, corners: [], sizeMm: c.sizeMm, pose: { t: p.t, R: p.R, reprojPx: 0.2 }, depthMm: null };
}

const shiftBy = (t: Vec3): Rigid => ({ R: I, t });

describe('sheet', () => {
	it('maps IDs to the printed sizes in order', () => {
		expect(sheetSizeMm(0)).toBe(40);
		expect(sheetSizeMm(8)).toBe(40);
		expect(sheetSizeMm(9)).toBe(30);
		expect(sheetSizeMm(44)).toBe(12);
		expect(sheetSizeMm(53)).toBe(8);
		expect(sheetSizeMm(54)).toBeNull();
		expect(sheetSizeMm(-1)).toBeNull();
	});

	it('minimum readable tag at 1 ft on the 640x480 stream is ~12 mm', () => {
		expect(minTagSizeMm(305, 615)).toBeCloseTo(11.9, 1);
	});
});

describe('3-D helpers', () => {
	it('rotation angle and inverse', () => {
		const R = axisAngle([0, 0, 1], 30);
		expect(rotationAngleDeg(R)).toBeCloseTo(30, 6);
		const a: Rigid = { R, t: [10, -5, 300] };
		const back = compose(a, invert(a));
		expect(rotationAngleDeg(back.R)).toBeCloseTo(0, 6);
		back.t.forEach((v) => expect(v).toBeCloseTo(0, 6));
	});
});

describe('assessTags', () => {
	it('reports the D415 depth change (now minus calibration)', () => {
		const c = { ...cal(53, 'arm', [10, 5, 300]), depthMm: 301.5 };
		const d = { ...seen(c), depthMm: 305.0 };
		const a = assessTags([c], [d]);
		expect(a.markers[0].offDepthMm).toBeCloseTo(3.5, 6);
		expect(a.markers[0].status).toBe('ok');
		// Null when either side has no depth, and for a missing tag.
		expect(assessTags([c], [seen(c)]).markers[0].offDepthMm).toBeNull();
		expect(assessTags([cal(53, 'arm', [10, 5, 300])], [d]).markers[0].offDepthMm).toBeNull();
		expect(assessTags([c], []).markers[0].offDepthMm).toBeNull();
	});

	describe('depth as distance', () => {
		// An 8 mm tag at home: depth says 300 on both sides, the image pose jitters.
		const c = { ...cal(53, 'arm', [30, -15, 300]), depthMm: 300 };

		it('slides both poses along their sight lines to the depth, so image-z jitter is not movement', () => {
			// Image pose 12 mm further away (x/y scaled with it, as a size error does); depth unchanged.
			const d = { ...seen(c), pose: { t: [31.2, -15.6, 312] as Vec3, R: I, reprojPx: 0.2 }, depthMm: 300.4 };
			const m = assessTags([c], [d]).markers[0];
			expect(m.zSource).toBe('depth');
			expect(m.zMm).toBeCloseTo(300.4, 6);
			expect(m.imageZMm).toBeCloseTo(312, 6);
			expect(m.offMm!).toBeLessThan(0.5);
			expect(m.status).toBe('ok');
			// The same frame judged on the image alone reads 12 mm off.
			const img = assessTags([c], [d], DEFAULT_TOLERANCES, { depthZ: false }).markers[0];
			expect(img.zSource).toBe('image');
			expect(img.offMm!).toBeCloseTo(Math.hypot(1.2, 0.6, 12), 6);
			expect(img.status).toBe('moved');
		});

		it('a real move shows in depth too', () => {
			const d = { ...seen(c, IDENTITY, shiftBy([0, 0, 14])), depthMm: 314 };
			const m = assessTags([c], [d]).markers[0];
			expect(m.zSource).toBe('depth');
			expect(m.offMm!).toBeCloseTo(14, 6);
			expect(m.status).toBe('moved');
			expect(m.over).toEqual(['mm']);
		});

		it('falls back to the image on both sides when either lacks depth or the reading is not the tag', () => {
			const d = { ...seen(c, IDENTITY, shiftBy([0, 0, 8])), depthMm: null };
			expect(assessTags([c], [d]).markers[0]).toMatchObject({ zSource: 'image', zMm: 308, offMm: 8 });
			const noCalDepth = { ...c, depthMm: null };
			expect(assessTags([noCalDepth], [{ ...d, depthMm: 308 }]).markers[0]).toMatchObject({ zSource: 'image', offMm: 8 });
			// Depth 420 against an image z of 300 is the bench behind the tag's edge, not the tag.
			const behind = assessTags([c], [{ ...seen(c), depthMm: 420 }]).markers[0];
			expect(behind).toMatchObject({ zSource: 'image', zMm: 300, offMm: 0 });
			expect(behind.offDepthMm).toBeCloseTo(120, 6);
		});

		it('a camera bump measured on depth-driven fixed tags is still undone before the arm tag is judged', () => {
			const fixedA = { ...cal(0, 'fixed', [-80, 40, 400]), depthMm: 400 };
			const fixedB = { ...cal(1, 'fixed', [90, 40, 420]), depthMm: 420 };
			const fixedC = { ...cal(2, 'fixed', [0, -60, 380]), depthMm: 380 };
			const arm = { ...cal(53, 'arm', [30, -15, 300]), depthMm: 300 };
			const bump = shiftBy([0, 0, 20]);
			const dets = [fixedA, fixedB, fixedC, arm].map((x) => ({ ...seen(x, bump), depthMm: x.depthMm! + 20 }));
			const a = assessTags([fixedA, fixedB, fixedC, arm], dets);
			expect(a.cameraShift?.compensated).toBe(true);
			expect(a.cameraShift?.mm).toBeCloseTo(20, 4);
			expect(a.markers.map((m) => m.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
			expect(a.markers.every((m) => m.zSource === 'depth')).toBe(true);
		});
	});

	const fixed = [cal(0, 'fixed', [-80, 40, 300]), cal(1, 'fixed', [90, 50, 310]), cal(2, 'fixed', [0, 80, 290])];
	const arm = [cal(20, 'arm', [10, -20, 250]), cal(21, 'arm', [-30, -10, 260])];
	const all = [...fixed, ...arm];

	it('everything in place → ok', () => {
		const a = assessTags(all, all.map((c) => seen(c)));
		expect(a.verdict).toBe('ok');
		expect(a.okCount).toBe(5);
		expect(a.cameraShift?.compensated).toBe(false);
	});

	// 15 mm: past the 10 mm default (DEFAULT_TOLERANCES, shared with Calibrate home; 5 → 10 on 2026-10-23).
	it('an arm tag that moved 15 mm is reported, others ok', () => {
		const dets = all.map((c) => (c.tagId === 20 ? seen(c, IDENTITY, shiftBy([15, 0, 0])) : seen(c)));
		const a = assessTags(all, dets);
		expect(a.verdict).toBe('off');
		const t = a.markers.find((m) => m.tagId === 20)!;
		expect(t.status).toBe('moved');
		expect(t.over).toEqual(['mm']);
		expect(t.offMm).toBeCloseTo(15, 6);
		expect(a.markers.filter((m) => m.tagId !== 20).every((m) => m.over.length === 0)).toBe(true);
		expect(describeVision(a)).toContain('Tag 20 15.0 mm');
	});

	it('a tag spun about its normal is off by angle even in place', () => {
		const c = arm[0];
		const turned = { ...seen(c), pose: { t: c.pose!.t, R: axisAngle([0, 0, 1], 12), reprojPx: 0.2 } };
		const a = assessTags(all, all.map((x) => (x.tagId === c.tagId ? turned : seen(x))));
		const m = a.markers.find((m) => m.tagId === c.tagId)!;
		expect(m.offDeg).toBeCloseTo(12, 6);
		expect(m.offTiltDeg).toBeCloseTo(0, 6);
		expect(m.over).toEqual(['deg']);
		expect(a.verdict).toBe('off');
		expect(describeVision(a)).toContain('12.0° spin');
	});

	it('tilt alone is reported but never judged', () => {
		const c = arm[0];
		const tilted = { ...seen(c), pose: { t: c.pose!.t, R: axisAngle([1, 0, 0], 40), reprojPx: 0.2 } };
		const a = assessTags(all, all.map((x) => (x.tagId === c.tagId ? tilted : seen(x))));
		const m = a.markers.find((m) => m.tagId === c.tagId)!;
		expect(m.offTiltDeg).toBeCloseTo(40, 6);
		expect(m.offDeg).toBeCloseTo(0, 6);
		expect(m.over).toEqual([]);
		expect(m.status).toBe('ok');
		expect(a.verdict).toBe('ok');
	});

	it('moved AND spun names both measurements', () => {
		const c = arm[0];
		const both = { ...seen(c), pose: { t: [c.pose!.t[0] + 15, c.pose!.t[1], c.pose!.t[2]] as Vec3, R: axisAngle([0, 0, 1], 12), reprojPx: 0.2 } };
		const a = assessTags(all, all.map((x) => (x.tagId === c.tagId ? both : seen(x))));
		expect(a.markers.find((m) => m.tagId === c.tagId)!.over).toEqual(['mm', 'deg']);
	});

	it('angleDeg 0 disables the angle check', () => {
		const c = arm[0];
		const turned = { ...seen(c), pose: { t: c.pose!.t, R: axisAngle([0, 0, 1], 12), reprojPx: 0.2 } };
		const a = assessTags(all, all.map((x) => (x.tagId === c.tagId ? turned : seen(x))), { ...DEFAULT_TOLERANCES, angleDeg: 0 });
		expect(a.verdict).toBe('ok');
		expect(a.markers.find((m) => m.tagId === c.tagId)!.over).toEqual([]);
	});

	it('a bumped camera is measured on the fixed tags and undone', () => {
		const bump: Rigid = { R: axisAngle([0, 1, 0], 4), t: [15, -6, 10] };
		const a = assessTags(all, all.map((c) => seen(c, bump)));
		expect(a.verdict).toBe('ok');
		expect(a.cameraShift?.compensated).toBe(true);
		expect(a.cameraShift?.fixedUsed).toBe(3);
		expect(describeVision(a)).toContain('camera has shifted');
	});

	it('bumped camera AND an arm tag off → still finds the arm tag', () => {
		const bump: Rigid = { R: axisAngle([0, 1, 0], 4), t: [15, -6, 10] };
		const dets = all.map((c) => (c.tagId === 21 ? seen(c, bump, shiftBy([0, 0, -12])) : seen(c, bump)));
		const a = assessTags(all, dets);
		expect(a.verdict).toBe('off');
		expect(a.markers.filter((m) => m.status === 'moved').map((m) => m.tagId)).toEqual([21]);
		expect(a.markers.find((m) => m.tagId === 21)!.offMm).toBeCloseTo(12, 4);
	});

	it('one knocked fixed tag is outvoted by the others', () => {
		const dets = all.map((c) => (c.tagId === 1 ? seen(c, IDENTITY, shiftBy([30, 0, 0])) : seen(c)));
		const { shift, inliers } = estimateCameraShift(all, new Map(dets.map((d) => [d.id, d])), DEFAULT_TOLERANCES);
		expect(shift?.compensated).toBe(false);
		expect([...inliers].sort()).toEqual([0, 2]);
		const a = assessTags(all, dets);
		expect(a.markers.find((m) => m.tagId === 1)!.status).toBe('moved');
		expect(a.markers.filter((m) => m.role === 'arm').every((m) => m.status === 'ok')).toBe(true);
	});

	it('no fixed tag in view and everything shifted together → camera_moved', () => {
		const dets = arm.concat(cal(22, 'arm', [40, 0, 270])).map((c) => seen(c, shiftBy([20, 0, 0])));
		const a = assessTags(arm.concat(cal(22, 'arm', [40, 0, 270])), dets);
		expect(a.verdict).toBe('camera_moved');
	});

	it('missing tags and extra tags', () => {
		const dets = all.filter((c) => c.tagId !== 21).map((c) => seen(c));
		dets.push({ id: 50, center: [0.1, 0.1], corners: [], sizeMm: null, pose: null, depthMm: null });
		const a = assessTags(all, dets);
		expect(a.missingCount).toBe(1);
		expect(a.extraTagIds).toEqual([50]);
		expect(a.verdict).toBe('off');
		expect(describeVision(a)).toContain('Tag 21 (tag 21) not found');
	});

	it('falls back to picture distance without a pose', () => {
		const c = { ...arm[0], pose: null };
		const ok = assessTags([c], [{ id: c.tagId, center: [0.505, 0.5], corners: [], sizeMm: null, pose: null, depthMm: null }]);
		expect(ok.verdict).toBe('ok');
		const off = assessTags([c], [{ id: c.tagId, center: [0.55, 0.5], corners: [], sizeMm: null, pose: null, depthMm: null }]);
		expect(off.verdict).toBe('off');
		expect(off.markers[0].offMm).toBeNull();
		expect(off.markers[0].over).toEqual(['px']);
		expect(ok.markers[0].over).toEqual([]);
	});

	it('splitRotationDeg separates spin about the normal from tilt of it', () => {
		const swingThenTwist = matMul(axisAngle([1, 0, 0], 30), axisAngle([0, 0, 1], 20));
		expect(splitRotationDeg(swingThenTwist).spinDeg).toBeCloseTo(20, 6);
		expect(splitRotationDeg(swingThenTwist).tiltDeg).toBeCloseTo(30, 6);
		const twistThenSwing = matMul(axisAngle([0, 0, 1], -20), axisAngle([0, 1, 0], 30));
		expect(splitRotationDeg(twistThenSwing).spinDeg).toBeCloseTo(20, 6);
		expect(splitRotationDeg(twistThenSwing).tiltDeg).toBeCloseTo(30, 6);
		expect(splitRotationDeg(I)).toEqual({ spinDeg: 0, tiltDeg: 0 });
	});

	describe('planar-pose ambiguity', () => {
		// Calibrated: tag tilted 20° toward the camera. Live: the solver picked the
		// mirrored branch (tilted 20° away, i.e. 40° off) but offers the right one as alt.
		const c = cal(30, 'arm', [60, 0, 300], axisAngle([1, 0, 0], 20));
		const mirrored = axisAngle([1, 0, 0], -20);
		const live = (altReproj: number | null): TagDetection => ({
			id: 30,
			center: c.center,
			corners: [],
			sizeMm: 30,
			pose: { t: c.pose!.t, R: mirrored, reprojPx: 0.3, alt: { t: c.pose!.t, R: c.pose!.R, reprojPx: altReproj } },
			depthMm: null
		});

		it('a near-equal alternative that agrees with the calibration is taken', () => {
			expect(isAmbiguous(live(0.35).pose!)).toBe(true);
			const r = resolvePose(live(0.35).pose!, { R: c.pose!.R, t: c.pose!.t });
			expect(r.flipped).toBe(true);
			expect(r.ambiguous).toBe(true);
			const a = assessTags([c], [live(0.35)]);
			expect(a.markers[0].offTiltDeg).toBeCloseTo(0, 6);
			expect(a.markers[0].flipped).toBe(true);
			expect(a.markers[0].ambiguous).toBe(true);
		});

		it('a clearly worse alternative is left alone; the tilt shows but does not judge', () => {
			expect(isAmbiguous(live(3).pose!)).toBe(false);
			const a = assessTags([c], [live(3)]);
			expect(a.markers[0].flipped).toBe(false);
			expect(a.markers[0].ambiguous).toBe(false);
			expect(a.markers[0].offTiltDeg).toBeCloseTo(40, 6);
			expect(a.markers[0].status).toBe('ok');
		});

		it('a flipped fixed tag does not pull the camera-shift estimate', () => {
			const fixedTilted = cal(2, 'fixed', [-80, 0, 300], axisAngle([1, 0, 0], 20));
			const cals = [fixedTilted, ...all.filter((x) => x.tagId !== 2)];
			const dets = cals.map((x) =>
				x.tagId === 2
					? { ...seen(x), pose: { t: x.pose!.t, R: mirrored, reprojPx: 0.3, alt: { t: x.pose!.t, R: x.pose!.R, reprojPx: 0.32 } } }
					: seen(x)
			);
			const a = assessTags(cals, dets);
			expect(a.verdict).toBe('ok');
			expect(a.cameraShift?.compensated).toBe(false);
		});

		it('no alternative or no reference: the solver pick stands', () => {
			const plain = { ...live(0.35), pose: { t: c.pose!.t, R: mirrored, reprojPx: 0.3 } };
			expect(resolvePose(plain.pose, { R: c.pose!.R, t: c.pose!.t }).flipped).toBe(false);
			expect(resolvePose(live(0.35).pose!, null).flipped).toBe(false);
		});

		it('rescaleToSize scales the alternative too', () => {
			// Solved with 20 mm instead of the calibrated 30: both translations are 2/3 of the truth.
			const k = 20 / 30;
			const t3: Vec3 = [c.pose!.t[0] * k, c.pose!.t[1] * k, c.pose!.t[2] * k];
			const l = live(0.35);
			const d: TagDetection = { ...l, sizeMm: 20, pose: { ...l.pose!, t: t3, alt: { ...l.pose!.alt!, t: t3 } } };
			const a = assessTags([c], [d]);
			expect(a.markers[0].flipped).toBe(true);
			expect(a.markers[0].offMm).toBeCloseTo(0, 6);
		});
	});

	it('a registry size edit since calibration does not read as movement', () => {
		// Pi solved with 20 mm (today's registry); calibration used 30 mm → t scales by 1.5.
		const dets = all.map((c) => {
			const d = seen(c);
			return { ...d, sizeMm: 20, pose: { ...d.pose!, t: d.pose!.t.map((v) => (v * 20) / 30) as Vec3 } };
		});
		expect(assessTags(all, dets).verdict).toBe('ok');
	});

	it('empty calibration → no_markers', () => {
		expect(assessTags([], []).verdict).toBe('no_markers');
	});
});
