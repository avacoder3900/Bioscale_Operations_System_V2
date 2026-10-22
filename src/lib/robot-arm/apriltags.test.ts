import { describe, expect, it } from 'vitest';
import {
	assessTags,
	axisAngle,
	compose,
	describeVision,
	estimateCameraShift,
	invert,
	minTagSizeMm,
	rotationAngleDeg,
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
	const fixed = [cal(0, 'fixed', [-80, 40, 300]), cal(1, 'fixed', [90, 50, 310]), cal(2, 'fixed', [0, 80, 290])];
	const arm = [cal(20, 'arm', [10, -20, 250]), cal(21, 'arm', [-30, -10, 260])];
	const all = [...fixed, ...arm];

	it('everything in place → ok', () => {
		const a = assessTags(all, all.map((c) => seen(c)));
		expect(a.verdict).toBe('ok');
		expect(a.okCount).toBe(5);
		expect(a.cameraShift?.compensated).toBe(false);
	});

	it('an arm tag that moved 8 mm is reported, others ok', () => {
		const dets = all.map((c) => (c.tagId === 20 ? seen(c, IDENTITY, shiftBy([8, 0, 0])) : seen(c)));
		const a = assessTags(all, dets);
		expect(a.verdict).toBe('off');
		const t = a.markers.find((m) => m.tagId === 20)!;
		expect(t.status).toBe('moved');
		expect(t.over).toEqual(['mm']);
		expect(t.offMm).toBeCloseTo(8, 6);
		expect(a.markers.filter((m) => m.tagId !== 20).every((m) => m.over.length === 0)).toBe(true);
		expect(describeVision(a)).toContain('Tag 20 8.0 mm');
	});

	it('a turned tag is off by angle even in place', () => {
		const c = arm[0];
		const turned = { ...seen(c), pose: { t: c.pose!.t, R: axisAngle([1, 0, 0], 12), reprojPx: 0.2 } };
		const a = assessTags(all, all.map((x) => (x.tagId === c.tagId ? turned : seen(x))));
		expect(a.markers.find((m) => m.tagId === c.tagId)!.offDeg).toBeCloseTo(12, 6);
		expect(a.markers.find((m) => m.tagId === c.tagId)!.over).toEqual(['deg']);
		expect(a.verdict).toBe('off');
	});

	it('moved AND turned names both measurements', () => {
		const c = arm[0];
		const both = { ...seen(c), pose: { t: [c.pose!.t[0] + 9, c.pose!.t[1], c.pose!.t[2]] as Vec3, R: axisAngle([1, 0, 0], 12), reprojPx: 0.2 } };
		const a = assessTags(all, all.map((x) => (x.tagId === c.tagId ? both : seen(x))));
		expect(a.markers.find((m) => m.tagId === c.tagId)!.over).toEqual(['mm', 'deg']);
	});

	it('angleDeg 0 disables the angle check', () => {
		const c = arm[0];
		const turned = { ...seen(c), pose: { t: c.pose!.t, R: axisAngle([1, 0, 0], 12), reprojPx: 0.2 } };
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
