/**
 * Robot arm — sticker-marker vision (pure logic, no I/O). ARM-04.
 *
 * Coloured stickers are placed on the arm and its surroundings. The operator
 * registers each one in BIMS (any name, any group — none are built in), then
 * drags a virtual marker onto every sticker in a frozen camera frame. That
 * placement is the calibration. From then on every marker is found again in
 * each new frame by its colour, starting from where it was last seen, and is
 * compared to its calibrated position (and, when the camera reports depth, its
 * calibrated distance).
 *
 * This module runs in both places that track: the browser (live overlay, on
 * canvas ImageData) and the server (the home check, on sharp's raw output).
 * Everything here is deterministic and unit-tested.
 *
 * Coordinates are stored NORMALISED to the frame (0..1 on each axis) so a
 * calibration survives a change of stream resolution; tracking converts to
 * pixels at the frame it is given.
 */

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

export interface Hsv {
	/** degrees, [0, 360) */
	h: number;
	/** [0, 1] */
	s: number;
	/** [0, 1] */
	v: number;
}

/** Pixels in row-major order, 3 (RGB) or 4 (RGBA) bytes per pixel. */
export interface PixelImage {
	data: ArrayLike<number>;
	width: number;
	height: number;
	channels: 3 | 4;
}

/** How tolerant colour matching is for one marker. */
export interface ColorTolerance {
	/** Max hue distance in degrees (saturated stickers). */
	hue: number;
	/** Pixels less saturated than this never match a saturated sticker. */
	minSaturation: number;
	/** Pixels darker than this never match (shadow / black background). */
	minValue: number;
	/** Max RGB distance (0..441) — used for low-saturation stickers, where hue is meaningless. */
	rgb: number;
}

export const DEFAULT_TOLERANCE: ColorTolerance = { hue: 18, minSaturation: 0.3, minValue: 0.2, rgb: 45 };

/** Below this saturation a sticker is matched by RGB distance instead of hue. */
export const LOW_SATURATION = 0.25;

/**
 * A marker off its calibrated spot by more than this fraction of the frame
 * WIDTH counts as moved. 0.015 of a 640 px frame ≈ 10 px.
 */
export const DEFAULT_POSITION_TOLERANCE = 0.015;

/** A marker whose depth differs from calibration by more than this (mm) counts as off. */
export const DEFAULT_DEPTH_TOLERANCE_MM = 20;

/** How far (fraction of frame width) a marker is searched for around its last position. */
export const DEFAULT_SEARCH_RADIUS = 0.08;

/** Fewer matching pixels than this in a blob is noise, not a sticker. */
export const MIN_BLOB_PIXELS = 6;

// ── colour ───────────────────────────────────────────────────────────────

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const d = max - min;
	let h = 0;
	if (d > 0) {
		if (max === rn) h = ((gn - bn) / d) % 6;
		else if (max === gn) h = (bn - rn) / d + 2;
		else h = (rn - gn) / d + 4;
		h *= 60;
		if (h < 0) h += 360;
	}
	return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hueDistance(a: number, b: number): number {
	const d = Math.abs(a - b) % 360;
	return d > 180 ? 360 - d : d;
}

export function rgbToHex({ r, g, b }: Rgb): string {
	const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
	return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToRgb(hex: string): Rgb | null {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return null;
	const n = parseInt(m[1], 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Builds a per-pixel predicate for one target colour. Saturated targets match
 * on hue (robust to lighting); grey/white/black targets fall back to RGB
 * distance, because their hue is noise.
 */
export function colorMatcher(target: Rgb, tol: ColorTolerance = DEFAULT_TOLERANCE): (r: number, g: number, b: number) => boolean {
	const t = rgbToHsv(target);
	if (t.s < LOW_SATURATION) {
		const lim = tol.rgb * tol.rgb;
		return (r, g, b) => {
			const dr = r - target.r;
			const dg = g - target.g;
			const db = b - target.b;
			return dr * dr + dg * dg + db * db <= lim;
		};
	}
	// Half the target's own saturation, floored at the tolerance: a pale pink
	// sticker should still match itself, a vivid red should not match skin.
	const minS = Math.max(tol.minSaturation, t.s * 0.5);
	return (r, g, b) => {
		const p = rgbToHsv({ r, g, b });
		return p.v >= tol.minValue && p.s >= minS && hueDistance(p.h, t.h) <= tol.hue;
	};
}

/** True when a sticker colour is too grey to track reliably by hue (warn the operator). */
export function isLowSaturation(c: Rgb): boolean {
	return rgbToHsv(c).s < LOW_SATURATION;
}

/**
 * Median colour of the disc of radius `radiusPx` around (cx, cy), in pixels.
 * Median, not mean, so a glare highlight or a sliver of background at the
 * sticker's edge does not shift the sample.
 */
export function samplePatch(img: PixelImage, cx: number, cy: number, radiusPx = 3): Rgb | null {
	const rs: number[] = [];
	const gs: number[] = [];
	const bs: number[] = [];
	const r2 = radiusPx * radiusPx;
	const x0 = Math.max(0, Math.floor(cx - radiusPx));
	const x1 = Math.min(img.width - 1, Math.ceil(cx + radiusPx));
	const y0 = Math.max(0, Math.floor(cy - radiusPx));
	const y1 = Math.min(img.height - 1, Math.ceil(cy + radiusPx));
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			if ((x - cx) ** 2 + (y - cy) ** 2 > r2) continue;
			const i = (y * img.width + x) * img.channels;
			rs.push(img.data[i]);
			gs.push(img.data[i + 1]);
			bs.push(img.data[i + 2]);
		}
	}
	if (!rs.length) return null;
	const med = (a: number[]) => {
		a.sort((p, q) => p - q);
		return a[a.length >> 1];
	};
	return { r: med(rs), g: med(gs), b: med(bs) };
}

// ── tracking ─────────────────────────────────────────────────────────────

export interface TrackResult {
	/** Blob centroid, pixels. */
	x: number;
	y: number;
	/** Matching pixels in the chosen blob. */
	pixels: number;
}

/**
 * Find the sticker of colour `target` nearest `prior` (pixels), within
 * `searchRadiusPx`. Builds the colour mask inside the search window, labels
 * its 8-connected blobs, drops blobs smaller than `minPixels`, and returns the
 * centroid of the blob closest to the prior. Nearest-blob rather than
 * biggest-blob or the centroid of everything in the window, so two stickers of
 * the same colour near each other are not averaged into a point between them.
 * Returns null when nothing large enough is in range — the marker is lost.
 */
export function trackMarker(
	img: PixelImage,
	target: Rgb,
	prior: { x: number; y: number },
	o: { searchRadiusPx: number; tolerance?: ColorTolerance; minPixels?: number }
): TrackResult | null {
	const match = colorMatcher(target, o.tolerance ?? DEFAULT_TOLERANCE);
	const minPixels = o.minPixels ?? MIN_BLOB_PIXELS;
	const R = Math.max(2, o.searchRadiusPx);
	const x0 = Math.max(0, Math.floor(prior.x - R));
	const x1 = Math.min(img.width - 1, Math.ceil(prior.x + R));
	const y0 = Math.max(0, Math.floor(prior.y - R));
	const y1 = Math.min(img.height - 1, Math.ceil(prior.y + R));
	if (x1 < x0 || y1 < y0) return null;
	const w = x1 - x0 + 1;
	const h = y1 - y0 + 1;
	// 0 = no match, 1 = match unlabelled, >1 = visited
	const mask = new Uint8Array(w * h);
	const R2 = R * R;
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			if ((x - prior.x) ** 2 + (y - prior.y) ** 2 > R2) continue;
			const i = (y * img.width + x) * img.channels;
			if (match(img.data[i], img.data[i + 1], img.data[i + 2])) mask[(y - y0) * w + (x - x0)] = 1;
		}
	}
	let best: TrackResult | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	const stack: number[] = [];
	for (let start = 0; start < mask.length; start++) {
		if (mask[start] !== 1) continue;
		mask[start] = 2;
		stack.push(start);
		let n = 0;
		let sx = 0;
		let sy = 0;
		while (stack.length) {
			const k = stack.pop()!;
			const kx = k % w;
			const ky = (k - kx) / w;
			n++;
			sx += kx;
			sy += ky;
			for (let dy = -1; dy <= 1; dy++) {
				const ny = ky + dy;
				if (ny < 0 || ny >= h) continue;
				for (let dx = -1; dx <= 1; dx++) {
					const nx = kx + dx;
					if (nx < 0 || nx >= w) continue;
					const nk = ny * w + nx;
					if (mask[nk] === 1) {
						mask[nk] = 2;
						stack.push(nk);
					}
				}
			}
		}
		if (n < minPixels) continue;
		const cx = x0 + sx / n;
		const cy = y0 + sy / n;
		const d = (cx - prior.x) ** 2 + (cy - prior.y) ** 2;
		if (d < bestDist) {
			bestDist = d;
			best = { x: cx, y: cy, pixels: n };
		}
	}
	return best;
}

// ── calibration vs now ───────────────────────────────────────────────────

/** One marker as placed during calibration. x/y normalised to the frame. */
export interface Placement {
	markerId: string;
	name: string;
	group: string | null;
	/** Colour sampled from the sticker at calibration — what tracking matches. */
	color: Rgb;
	x: number;
	y: number;
	/** Camera distance to the sticker at calibration, mm (null = no depth). */
	depthMm: number | null;
}

export interface Observation {
	markerId: string;
	/** Normalised; null = not found in this frame. */
	x: number | null;
	y: number | null;
	depthMm: number | null;
	pixels: number;
}

export interface Tolerances {
	/** Fraction of frame width. */
	position: number;
	depthMm: number;
}

/** Track every placement in one frame, each starting from its prior (else its calibrated spot). */
export function trackAll(
	img: PixelImage,
	placements: Placement[],
	o: {
		priors?: Record<string, { x: number; y: number } | null | undefined>;
		searchRadius?: number;
		tolerance?: ColorTolerance;
	} = {}
): Observation[] {
	const searchRadiusPx = (o.searchRadius ?? DEFAULT_SEARCH_RADIUS) * img.width;
	return placements.map((p) => {
		const prior = o.priors?.[p.markerId] ?? { x: p.x, y: p.y };
		let hit = trackMarker(img, p.color, { x: prior.x * img.width, y: prior.y * img.height }, { searchRadiusPx, tolerance: o.tolerance });
		// Lost from the last position (fast move, or a frame where it was
		// occluded): look again around the calibrated spot before giving up.
		if (!hit && o.priors?.[p.markerId]) {
			hit = trackMarker(img, p.color, { x: p.x * img.width, y: p.y * img.height }, { searchRadiusPx, tolerance: o.tolerance });
		}
		return hit
			? { markerId: p.markerId, x: hit.x / img.width, y: hit.y / img.height, depthMm: null, pixels: hit.pixels }
			: { markerId: p.markerId, x: null, y: null, depthMm: null, pixels: 0 };
	});
}

export type MarkerStatus = 'ok' | 'moved' | 'depth_off' | 'missing';

export interface MarkerAssessment {
	markerId: string;
	name: string;
	group: string | null;
	status: MarkerStatus;
	/** Normalised displacement from the calibrated spot (null when missing). */
	dx: number | null;
	dy: number | null;
	/** |displacement| as a fraction of frame width. */
	distance: number | null;
	/** now − calibration, mm (null when either side has no depth). */
	depthDeltaMm: number | null;
	x: number | null;
	y: number | null;
	depthMm: number | null;
}

export type VisionVerdict = 'ok' | 'off' | 'camera_moved' | 'no_markers';

export interface VisionAssessment {
	verdict: VisionVerdict;
	markers: MarkerAssessment[];
	okCount: number;
	movedCount: number;
	missingCount: number;
	depthOffCount: number;
	/** Whether any marker had depth on both sides — i.e. depth actually took part. */
	depthUsed: boolean;
}

/**
 * Compare a frame's observations with the calibration. A marker is `moved`
 * when it is further than `position` (fraction of width) from its calibrated
 * spot, `depth_off` when it is in place on the picture but its distance to the
 * camera changed by more than `depthMm` (the lidar catches motion straight
 * toward or away from the lens, which the picture cannot see), `missing` when
 * it was not found at all.
 *
 * `camera_moved`: when at least three markers moved and they all moved the
 * same way by about the same amount, the likelier story is that the CAMERA was
 * bumped, not that everything in the scene shifted together. That is the cue
 * to recalibrate rather than to drive the arm.
 */
export function assessMarkers(placements: Placement[], observations: Observation[], tol: Tolerances): VisionAssessment {
	const byId = new Map(observations.map((o) => [o.markerId, o]));
	const markers: MarkerAssessment[] = placements.map((p) => {
		const o = byId.get(p.markerId);
		if (!o || o.x == null || o.y == null) {
			return { markerId: p.markerId, name: p.name, group: p.group, status: 'missing', dx: null, dy: null, distance: null, depthDeltaMm: null, x: null, y: null, depthMm: o?.depthMm ?? null };
		}
		const dx = o.x - p.x;
		const dy = o.y - p.y;
		const distance = Math.hypot(dx, dy);
		const depthDeltaMm = o.depthMm != null && p.depthMm != null ? o.depthMm - p.depthMm : null;
		const status: MarkerStatus =
			distance > tol.position ? 'moved' : depthDeltaMm != null && Math.abs(depthDeltaMm) > tol.depthMm ? 'depth_off' : 'ok';
		return { markerId: p.markerId, name: p.name, group: p.group, status, dx, dy, distance, depthDeltaMm, x: o.x, y: o.y, depthMm: o.depthMm };
	});
	const count = (s: MarkerStatus) => markers.filter((m) => m.status === s).length;
	const okCount = count('ok');
	const movedCount = count('moved');
	const missingCount = count('missing');
	const depthOffCount = count('depth_off');
	const depthUsed = markers.some((m) => m.depthDeltaMm != null);

	let verdict: VisionVerdict;
	if (!markers.length) verdict = 'no_markers';
	else if (okCount === markers.length) verdict = 'ok';
	else verdict = looksLikeCameraShift(markers, tol) ? 'camera_moved' : 'off';
	return { verdict, markers, okCount, movedCount, missingCount, depthOffCount, depthUsed };
}

/** All found markers moved, ≥3 of them, by nearly the same vector. */
function looksLikeCameraShift(markers: MarkerAssessment[], tol: Tolerances): boolean {
	const found = markers.filter((m) => m.dx != null && m.dy != null);
	if (found.length < 3 || found.some((m) => m.status !== 'moved')) return false;
	const mx = found.reduce((s, m) => s + m.dx!, 0) / found.length;
	const my = found.reduce((s, m) => s + m.dy!, 0) / found.length;
	// Every marker within one position-tolerance of the shared shift.
	return found.every((m) => Math.hypot(m.dx! - mx, m.dy! - my) <= tol.position);
}

/** Operator-facing sentence. `frameWidthPx` turns the fractions back into pixels for the text. */
export function describeVision(a: VisionAssessment, frameWidthPx: number): string {
	const px = (f: number) => `${Math.round(f * frameWidthPx)} px`;
	switch (a.verdict) {
		case 'no_markers':
			return 'This calibration has no markers placed.';
		case 'ok':
			return `All ${a.okCount} markers are at their calibrated positions${a.depthUsed ? ' (picture and depth)' : ''}.`;
		case 'camera_moved':
			return 'Every marker shifted the same way — the camera itself has probably moved. Recalibrate before trusting the arm check.';
		case 'off': {
			const bad = a.markers.filter((m) => m.status !== 'ok');
			const parts = bad.slice(0, 4).map((m) =>
				m.status === 'missing'
					? `${m.name} not found`
					: m.status === 'moved'
						? `${m.name} ${px(m.distance ?? 0)} off`
						: `${m.name} ${m.depthDeltaMm! > 0 ? '+' : ''}${Math.round(m.depthDeltaMm!)} mm depth`
			);
			const more = bad.length > 4 ? `, +${bad.length - 4} more` : '';
			return `${bad.length} of ${a.markers.length} markers are off: ${parts.join(', ')}${more}.`;
		}
	}
}
