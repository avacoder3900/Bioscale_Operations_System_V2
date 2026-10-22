/**
 * Robot arm — AprilTag vision (pure logic, no I/O). ARM-05.
 *
 * Replaces ARM-04's coloured stickers. The markers are the printed AprilTag
 * 36h11 sheet (services/robot-arm/calibration/apriltag-sheet.html): every tag
 * carries a unique ID, so identity is never in doubt. Detection runs on the
 * Pi (services/robot-arm/src/server/apriltags.py), which returns per tag its
 * corners on the picture and — from the printed size and the camera's
 * intrinsics — its pose relative to the camera in millimetres.
 *
 * A calibration stores every registered tag's pose with the arm parked at
 * home. A check compares each tag now against that, in mm and degrees.
 * Tags registered as `fixed` (deck, Opentron, frame — anything that never
 * moves) tell us whether the CAMERA moved: if they all shifted together, that
 * shift is undone before the `arm` tags are judged, so a bumped camera no
 * longer blinds the home check.
 *
 * Runs in both the browser (live view) and the server (home check, agent
 * API). Everything here is deterministic and unit-tested.
 */

// ── the printed sheet ────────────────────────────────────────────────────

/** Sizes on Giovanni's sheet: 9 tags each, IDs handed out in this order. */
export const SHEET_SIZES_MM = [40, 30, 20, 15, 12, 8] as const;
export const SHEET_PER_SIZE = 9;
export const SHEET_MAX_ID = SHEET_SIZES_MM.length * SHEET_PER_SIZE - 1;
/** tag36h11 has 587 codes. */
export const MAX_TAG_ID = 586;

/** Printed black-square edge for a sheet ID, or null for an ID not on the sheet. */
export function sheetSizeMm(tagId: number): number | null {
	if (!Number.isInteger(tagId) || tagId < 0 || tagId > SHEET_MAX_ID) return null;
	return SHEET_SIZES_MM[Math.floor(tagId / SHEET_PER_SIZE)];
}

/**
 * Smallest tag that decodes reliably at `distanceMm` for a camera of focal
 * length `fxPx` (pixels). A 36h11 black square is 8 cells across and the
 * detector wants about 3 px per cell: size ≥ 24 px × distance / f.
 * At 640×480 on the D415 (f ≈ 615 px) and 1 ft that is ~12 mm.
 */
export function minTagSizeMm(distanceMm: number, fxPx: number, pxPerCell = 3): number {
	return (8 * pxPerCell * distanceMm) / fxPx;
}

// ── types ────────────────────────────────────────────────────────────────

export type Vec3 = [number, number, number];
/** 3×3 rotation, row-major. */
export type Mat3 = number[];

/** Tag in the camera frame (x right, y down, z out of the lens), mm. */
export interface TagPose {
	t: Vec3;
	R: Mat3;
	reprojPx: number | null;
}

export type TagRole = 'fixed' | 'arm';

/** One tag as the Pi saw it. Positions normalised to the frame. */
export interface TagDetection {
	id: number;
	center: [number, number];
	corners: [number, number][];
	sizeMm: number | null;
	pose: TagPose | null;
	depthMm: number | null;
}

/** One registered tag as stored in a calibration. */
export interface CalibratedTag {
	markerId: string;
	tagId: number;
	name: string;
	group: string | null;
	role: TagRole;
	sizeMm: number;
	center: [number, number];
	corners: [number, number][];
	pose: TagPose | null;
	depthMm: number | null;
}

export interface Tolerances {
	/** A tag further than this from its home position (mm) is off. */
	positionMm: number;
	/** A tag turned more than this (degrees) is off. 0 = angle not checked. */
	angleDeg: number;
	/** Fallback when a pose is missing on either side: fraction of frame width. */
	pixel: number;
}

export const DEFAULT_TOLERANCES: Tolerances = { positionMm: 5, angleDeg: 5, pixel: 0.015 };

// ── 3-D helpers ──────────────────────────────────────────────────────────

export interface Rigid {
	R: Mat3;
	t: Vec3;
}

export const IDENTITY: Rigid = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

export function matMul(a: Mat3, b: Mat3): Mat3 {
	const o: number[] = new Array(9).fill(0);
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
	return o;
}

export function transpose(a: Mat3): Mat3 {
	return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}

export function apply(R: Mat3, v: Vec3): Vec3 {
	return [
		R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
		R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
		R[6] * v[0] + R[7] * v[1] + R[8] * v[2]
	];
}

export function compose(a: Rigid, b: Rigid): Rigid {
	const t = apply(a.R, b.t);
	return { R: matMul(a.R, b.R), t: [t[0] + a.t[0], t[1] + a.t[1], t[2] + a.t[2]] };
}

export function invert(a: Rigid): Rigid {
	const Rt = transpose(a.R);
	const t = apply(Rt, a.t);
	return { R: Rt, t: [-t[0], -t[1], -t[2]] };
}

export function dist3(a: Vec3, b: Vec3): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Angle of a rotation matrix, degrees [0, 180]. */
export function rotationAngleDeg(R: Mat3): number {
	const c = (R[0] + R[4] + R[8] - 1) / 2;
	return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

/** Rotation by `deg` about axis (unit) — used by tests and the camera-shift check. */
export function axisAngle(axis: Vec3, deg: number): Mat3 {
	const n = Math.hypot(...axis) || 1;
	const [x, y, z] = axis.map((v) => v / n);
	const a = (deg * Math.PI) / 180;
	const c = Math.cos(a);
	const s = Math.sin(a);
	const C = 1 - c;
	return [
		c + x * x * C, x * y * C - z * s, x * z * C + y * s,
		y * x * C + z * s, c + y * y * C, y * z * C - x * s,
		z * x * C - y * s, z * y * C + x * s, c + z * z * C
	];
}

function rigidOf(p: TagPose): Rigid {
	return { R: p.R, t: p.t };
}

/** How far `now` is from `expected`: translation mm and rotation degrees. */
export function poseDelta(expected: Rigid, now: Rigid): { mm: number; deg: number } {
	return { mm: dist3(expected.t, now.t), deg: rotationAngleDeg(matMul(transpose(expected.R), now.R)) };
}

function within(d: { mm: number; deg: number }, tol: Tolerances): boolean {
	return d.mm <= tol.positionMm && (tol.angleDeg <= 0 || d.deg <= tol.angleDeg);
}

// ── camera shift ─────────────────────────────────────────────────────────

export interface CameraShift {
	/** How far the fixed tags appear to have moved, mean mm. */
	mm: number;
	/** Rotation of the camera, degrees. */
	deg: number;
	/** Fixed tags that agree with the shift (seen in both frames). */
	fixedUsed: number;
	/** Fixed tags seen in both frames. */
	fixedSeen: number;
	/** The shift was large enough to be applied before judging the arm tags. */
	compensated: boolean;
}

/**
 * The camera's motion since calibration, from the fixed tags.
 *
 * For a fixed tag f, M_f = P_now_f · P_cal_f⁻¹ maps where anything was at
 * calibration to where the camera sees it now. Each fixed tag proposes its
 * M; the one most other fixed tags agree with wins (a single fixed tag that
 * was knocked loose is outvoted). Below tolerance the shift is noise and
 * identity is used — a tag's own pose jitter must not be pushed onto the arm.
 */
export function estimateCameraShift(
	cal: CalibratedTag[],
	now: Map<number, TagDetection>,
	tol: Tolerances
): { M: Rigid; shift: CameraShift | null; inliers: Set<number> } {
	const pairs = cal
		.filter((c) => c.role === 'fixed' && c.pose)
		.map((c) => ({ c, d: now.get(c.tagId) }))
		.filter((p): p is { c: CalibratedTag; d: TagDetection & { pose: TagPose } } => !!p.d?.pose);
	if (!pairs.length) return { M: IDENTITY, shift: null, inliers: new Set() };

	let best: { M: Rigid; inliers: Set<number>; err: number } | null = null;
	for (const cand of pairs) {
		const M = compose(rigidOf(cand.d.pose), invert(rigidOf(cand.c.pose!)));
		const inliers = new Set<number>();
		let err = 0;
		for (const p of pairs) {
			const d = poseDelta(compose(M, rigidOf(p.c.pose!)), rigidOf(p.d.pose));
			if (within(d, tol)) {
				inliers.add(p.c.tagId);
				err += d.mm;
			}
		}
		if (!best || inliers.size > best.inliers.size || (inliers.size === best.inliers.size && err < best.err)) best = { M, inliers, err };
	}
	const M = best!.M;
	const used = pairs.filter((p) => best!.inliers.has(p.c.tagId));
	const mm = used.reduce((s, p) => s + dist3(compose(M, rigidOf(p.c.pose!)).t, p.c.pose!.t), 0) / used.length;
	const deg = rotationAngleDeg(M.R);
	const compensated = mm > tol.positionMm || (tol.angleDeg > 0 && deg > tol.angleDeg);
	return {
		M: compensated ? M : IDENTITY,
		shift: { mm, deg, fixedUsed: used.length, fixedSeen: pairs.length, compensated },
		inliers: best!.inliers
	};
}

// ── assessment ───────────────────────────────────────────────────────────

export type TagStatus = 'ok' | 'moved' | 'missing';

/** Which measurement put a tag over tolerance: distance, turn, or picture distance (no pose). */
export type OverTolerance = 'mm' | 'deg' | 'px';

export interface TagAssessment {
	markerId: string;
	tagId: number;
	name: string;
	group: string | null;
	role: TagRole;
	status: TagStatus;
	/**
	 * The measurements that made it `moved`, so the UI can point at the number
	 * that is over tolerance: 'mm' (further than positionMm), 'deg' (turned
	 * more than angleDeg), 'px' (picture fallback without a pose). Empty when
	 * ok or missing.
	 */
	over: OverTolerance[];
	/** Off from home, mm (after undoing a camera shift); null without pose. */
	offMm: number | null;
	/** Turned from home, degrees; null without pose. */
	offDeg: number | null;
	/** Picture displacement, fraction of frame width (not shift-compensated). */
	offPx: number | null;
	/** Where it is now on the picture (normalised); null = not seen. */
	center: [number, number] | null;
	corners: [number, number][] | null;
	/** Distance from the camera now (pose z), mm. */
	zMm: number | null;
	/** D415 depth at the tag now, mm — independent cross-check of zMm. */
	depthMm: number | null;
}

export type VisionVerdict = 'ok' | 'off' | 'camera_moved' | 'no_markers';

export interface VisionAssessment {
	verdict: VisionVerdict;
	markers: TagAssessment[];
	okCount: number;
	movedCount: number;
	missingCount: number;
	cameraShift: CameraShift | null;
	/** Detected tags that are not in the calibration (unregistered or added since). */
	extraTagIds: number[];
}

/**
 * Compare the tags seen now with the calibration. A tag is `moved` when,
 * after undoing any camera shift the fixed tags reveal, it is further than
 * `positionMm` or turned more than `angleDeg` from home; `missing` when the
 * Pi did not find it. Without a pose on either side, picture distance is the
 * fallback (fraction of width).
 *
 * `camera_moved` is only the verdict when the shift could NOT be undone — no
 * fixed tag was visible — and at least three tags all moved together. With
 * fixed tags in view a camera bump is measured and compensated instead.
 */
export function assessTags(cal: CalibratedTag[], detections: TagDetection[], tol: Tolerances = DEFAULT_TOLERANCES): VisionAssessment {
	// Calibrated sizes win over today's registry: a size edit must not look like the arm moving.
	const calSize = new Map(cal.map((c) => [c.tagId, c.sizeMm]));
	const now = new Map(detections.map((d) => [d.id, rescaleToSize(d, calSize.get(d.id))]));
	const { M, shift } = estimateCameraShift(cal, now, tol);

	const markers: TagAssessment[] = cal.map((c) => {
		const d = now.get(c.tagId);
		const base = { markerId: c.markerId, tagId: c.tagId, name: c.name, group: c.group, role: c.role };
		if (!d) {
			return { ...base, status: 'missing', over: [], offMm: null, offDeg: null, offPx: null, center: null, corners: null, zMm: null, depthMm: null };
		}
		const offPx = Math.hypot(d.center[0] - c.center[0], d.center[1] - c.center[1]);
		let offMm: number | null = null;
		let offDeg: number | null = null;
		const over: OverTolerance[] = [];
		if (c.pose && d.pose) {
			const delta = poseDelta(compose(M, rigidOf(c.pose)), rigidOf(d.pose));
			offMm = delta.mm;
			offDeg = delta.deg;
			if (delta.mm > tol.positionMm) over.push('mm');
			if (tol.angleDeg > 0 && delta.deg > tol.angleDeg) over.push('deg');
		} else if (offPx > tol.pixel) {
			over.push('px');
		}
		return {
			...base,
			status: over.length ? 'moved' : 'ok',
			over,
			offMm,
			offDeg,
			offPx,
			center: d.center,
			corners: d.corners,
			zMm: d.pose ? d.pose.t[2] : null,
			depthMm: d.depthMm
		};
	});

	const count = (s: TagStatus) => markers.filter((m) => m.status === s).length;
	const okCount = count('ok');
	const movedCount = count('moved');
	const missingCount = count('missing');
	const calIds = new Set(cal.map((c) => c.tagId));
	const extraTagIds = detections.map((d) => d.id).filter((id) => !calIds.has(id));

	let verdict: VisionVerdict;
	if (!markers.length) verdict = 'no_markers';
	else if (okCount === markers.length) verdict = 'ok';
	else if (!shift && looksLikeCameraShift(cal, now, markers, tol)) verdict = 'camera_moved';
	else verdict = 'off';
	return { verdict, markers, okCount, movedCount, missingCount, cameraShift: shift, extraTagIds };
}

/** A pose's translation scales linearly with the tag size it was solved for. */
export function rescaleToSize(d: TagDetection, sizeMm: number | undefined): TagDetection {
	if (!d.pose || !sizeMm || !d.sizeMm || d.sizeMm === sizeMm) return d;
	const k = sizeMm / d.sizeMm;
	return { ...d, sizeMm, pose: { ...d.pose, t: [d.pose.t[0] * k, d.pose.t[1] * k, d.pose.t[2] * k] } };
}

/** No fixed tag to measure it: ≥3 tags all moved, by nearly the same 3-D vector. */
function looksLikeCameraShift(cal: CalibratedTag[], now: Map<number, TagDetection>, markers: TagAssessment[], tol: Tolerances): boolean {
	const found = markers.filter((m) => m.status !== 'missing');
	if (found.length < 3 || found.some((m) => m.status !== 'moved')) return false;
	const vecs: Vec3[] = [];
	for (const m of found) {
		const c = cal.find((x) => x.tagId === m.tagId)?.pose;
		const d = now.get(m.tagId)?.pose;
		if (!c || !d) return false;
		vecs.push([d.t[0] - c.t[0], d.t[1] - c.t[1], d.t[2] - c.t[2]]);
	}
	const mean: Vec3 = [0, 1, 2].map((i) => vecs.reduce((s, v) => s + v[i], 0) / vecs.length) as Vec3;
	return vecs.every((v) => dist3(v, mean) <= tol.positionMm);
}

/** Operator-facing sentence. */
export function describeVision(a: VisionAssessment): string {
	const shift =
		a.cameraShift?.compensated
			? ` The camera has shifted ~${Math.round(a.cameraShift.mm)} mm / ${a.cameraShift.deg.toFixed(1)}° since calibration (measured on ${a.cameraShift.fixedUsed} fixed tag(s) and undone) — recalibrate when convenient.`
			: '';
	switch (a.verdict) {
		case 'no_markers':
			return 'This calibration has no tags.';
		case 'ok':
			return `All ${a.okCount} tags are at their home positions.${shift}`;
		case 'camera_moved':
			return 'Every tag shifted the same way and no fixed tag is in view — the camera itself has probably moved. Recalibrate before trusting the arm check.';
		case 'off': {
			const bad = a.markers.filter((m) => m.status !== 'ok');
			const parts = bad.slice(0, 4).map((m) =>
				m.status === 'missing'
					? `${m.name} (tag ${m.tagId}) not found`
					: m.offMm != null
						? `${m.name} ${m.offMm.toFixed(1)} mm${m.offDeg != null && m.offDeg >= 1 ? ` / ${m.offDeg.toFixed(1)}°` : ''} off`
						: `${m.name} off on the picture`
			);
			const more = bad.length > 4 ? `, +${bad.length - 4} more` : '';
			return `${bad.length} of ${a.markers.length} tags are off: ${parts.join(', ')}${more}.${shift}`;
		}
	}
}
