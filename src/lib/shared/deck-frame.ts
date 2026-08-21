/**
 * Deck frame geometry — "where is the deck, and how big is it?".
 *
 * The operator jogs the pipette tip to the four physical corners of the deck
 * plate. Those four points are the ONLY input: unlike a labware well, a plate
 * corner has no nominal coordinate to fit against, so the frame is defined
 * entirely by what was taught.
 *
 * What that buys us: the tip calibrator stops being a bare absolute point that
 * silently goes stale the moment the deck is reseated. Stored as a fraction of
 * the frame, re-teaching the corners re-derives its absolute position — no
 * re-probing the fixture.
 *
 * Pure and DB-free on purpose (same contract as tip-calibrator.ts): form
 * validation runs these on raw request input, and the unit tests run them with
 * no robot and no Mongo. Nothing here moves a pipette or writes a document.
 *
 * Lives in $lib/shared rather than beside its sibling services under
 * $lib/server BECAUSE it is pure. SvelteKit hard-blocks $lib/server imports from
 * components, and the Studio has to derive a frame CLIENT-side to show the
 * operator the deck's size and fit quality as each corner is captured — before
 * anything is saved. The alternative is a second copy of the fit in the
 * component, and two implementations of the same geometry drifting apart is
 * exactly the class of bug the tip-calibrator module was written to end.
 *
 * GUARD PHILOSOPHY, carried from tip-calibrator.ts: reject, never clamp. A
 * clamped corner would silently define a deck the operator never taught, and
 * every hole derived from it would be wrong by that amount with nothing to show
 * for it. A refused frame is a message on screen; a clamped one is a crash three
 * steps later.
 */

/** The four corners, named from the operator's view standing at the robot. */
export type CornerLabel = 'FL' | 'FR' | 'BL' | 'BR';

/** Teach order — also the winding order used for the convexity check. */
export const CORNER_LABELS: readonly CornerLabel[] = ['FL', 'FR', 'BR', 'BL'] as const;

/** Human-readable corner names, for error messages the operator has to act on. */
export const CORNER_NAMES: Record<CornerLabel, string> = {
	FL: 'front-left',
	FR: 'front-right',
	BR: 'back-right',
	BL: 'back-left'
};

export interface Corner {
	label: CornerLabel;
	x: number;
	y: number;
	z: number;
}

export interface Point2 {
	x: number;
	y: number;
}

/**
 * The unit-square coordinates of each corner. This is what the affine fit maps
 * the taught points ONTO, and it is what fixes the meaning of u and v:
 *
 *   u = 0 at the left edge,  u = 1 at the right edge
 *   v = 0 at the front edge, v = 1 at the back edge
 *
 * So a calibrator at (u 0.34, v 0.48) sits roughly a third of the way right and
 * just under halfway back, whatever the deck's absolute position happens to be.
 */
const UNIT_SQUARE: Record<CornerLabel, Point2> = {
	FL: { x: 0, y: 0 },
	FR: { x: 1, y: 0 },
	BR: { x: 1, y: 1 },
	BL: { x: 0, y: 1 }
};

/**
 * Plausible deck edge lengths in mm.
 *
 * Deliberately WIDE — this catches garbage (two corners taught at the same
 * place, a corner jogged to the wrong side of the deck, a stray 0), not a deck
 * that is a few mm off nominal. The OT-2's own usable envelope is roughly
 * 420 x 390 mm, so nothing legitimate can exceed it; the floor is set well
 * under any real deck this fleet runs.
 */
export const DECK_EDGE_LIMITS = { min: 40, max: 420 } as const;

/**
 * How far a taught corner may sit from the fitted rectangle before the frame is
 * refused, in mm.
 *
 * The fit has 6 parameters and 8 constraints (4 corners x 2 axes), so a
 * perfectly-taught rectangle lands at ~0 and any real slop shows up here. This
 * is the number that separates "the deck is slightly rotated in its seat",
 * which is exactly what the frame exists to capture, from "one of these four
 * points is not a corner of the same rectangle as the other three".
 *
 * CALIBRATE THIS AGAINST THE 4x ATTENUATION, not against jog precision. Six of
 * the eight constraints are spent fitting the rectangle, so the fit absorbs
 * three quarters of a single mis-jogged corner and leaves only a quarter of it
 * in the residual — a corner taught 8 mm out of place reads as 2 mm here
 * (locked down in deck-frame.test.ts). The threshold is therefore a QUARTER of
 * the single-corner error we intend to catch:
 *
 *   1 mm here  ⇒  a corner off by 4 mm or more is refused
 *
 * Teach repeatability is far below that — 0.1 mm jog steps, and independent
 * per-corner slop partially cancels in the fit — so this leaves real margin
 * while still catching an operator who taught the wrong physical feature.
 */
export const MAX_RESIDUAL_MM = 1;

/**
 * The deck's own affine frame, derived from the four taught corners.
 *
 * `origin`, `uAxis` and `vAxis` are the forward map (unit square → mm):
 *   absolute = origin + u * uAxis + v * vAxis
 * which is exactly what fromFrameRelative() evaluates.
 */
export interface DeckFrameDerived {
	/** Absolute mm position of (u 0, v 0) — the fitted front-left corner. */
	origin: Point2;
	/** Absolute mm vector spanned by u going 0 → 1 (the front edge). */
	uAxis: Point2;
	/** Absolute mm vector spanned by v going 0 → 1 (the left edge). */
	vAxis: Point2;
	/** Length of uAxis — the deck's taught width, mm. */
	width: number;
	/** Length of vAxis — the deck's taught depth, mm. */
	height: number;
	/** How far the deck is rotated in its seat, degrees CCW from +x. */
	rotationDeg: number;
	/**
	 * Departure from a right angle between the two edges, degrees. A deck that
	 * is square in its seat reads ~0; a large value means the taught quad is a
	 * parallelogram or worse, which usually means a corner was mis-jogged.
	 */
	squarenessDeg: number;
	/** Worst corner's distance from the fitted rectangle, mm. The quality metric. */
	residualMm: number;
	/** Mean Z of the four corners — the deck surface height the corners sat at. */
	surfaceZ: number;
}

/** Finite-number guard: anything not a real number becomes undefined, never 0. */
export function finite(v: unknown): number | undefined {
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * Everything that can be wrong with a set of taught corners, as a message the
 * operator can act on. Returns null when the corners are usable.
 *
 * Runs BEFORE the fit, because a fit over garbage produces a confident-looking
 * frame rather than an error — the degenerate cases below all yield finite
 * numbers if you let them through.
 */
export function validateCorners(corners: unknown): string | null {
	if (!Array.isArray(corners)) return 'Teach all four deck corners first';
	if (corners.length !== 4) {
		return `All four deck corners are required — ${corners.length} taught so far`;
	}

	const seen = new Set<string>();
	for (const label of CORNER_LABELS) {
		const c = corners.find((k: any) => k?.label === label);
		if (!c) return `The ${CORNER_NAMES[label]} corner has not been taught yet`;
		// Every axis explicitly, so a half-captured corner cannot ride through as a 0.
		for (const axis of ['x', 'y', 'z'] as const) {
			if (finite((c as any)[axis]) === undefined) {
				return `The ${CORNER_NAMES[label]} corner has no ${axis} reading — re-capture it`;
			}
		}
		if (seen.has(label)) return `The ${CORNER_NAMES[label]} corner was taught twice`;
		seen.add(label);
	}

	// Distinctness, pairwise. Two corners at the same point collapse the deck to
	// a line or a point, which fits perfectly and means nothing.
	const pts = CORNER_LABELS.map((l) => corners.find((k: any) => k.label === l) as Corner);
	for (let i = 0; i < pts.length; i++) {
		for (let j = i + 1; j < pts.length; j++) {
			if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < 1) {
				return (
					`The ${CORNER_NAMES[pts[i].label]} and ${CORNER_NAMES[pts[j].label]} corners are ` +
					`at the same place — each corner must be jogged to its own physical corner`
				);
			}
		}
	}

	// Convexity + winding. Taught in FL → FR → BR → BL order the cross products
	// are all the same sign; a swapped pair (the classic "I captured FR into the
	// BR slot") produces a bow-tie and flips one of them.
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = pts[i];
		const b = pts[(i + 1) % 4];
		const c = pts[(i + 2) % 4];
		const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
		if (Math.abs(cross) < 1e-9) continue; // collinear triple — caught by the edge check
		const s = Math.sign(cross);
		if (sign === 0) sign = s;
		else if (s !== sign) {
			return (
				'Those four points cross over each other rather than forming a rectangle — ' +
				'check that each corner was captured into the matching slot'
			);
		}
	}

	// Edge lengths. Uses the taught edges directly (not the fit) so the message
	// can name the two corners the operator has to look at.
	for (let i = 0; i < 4; i++) {
		const a = pts[i];
		const b = pts[(i + 1) % 4];
		const len = Math.hypot(b.x - a.x, b.y - a.y);
		if (len < DECK_EDGE_LIMITS.min || len > DECK_EDGE_LIMITS.max) {
			return (
				`The ${CORNER_NAMES[a.label]} → ${CORNER_NAMES[b.label]} edge measures ` +
				`${len.toFixed(1)} mm, outside the ${DECK_EDGE_LIMITS.min}–${DECK_EDGE_LIMITS.max} mm ` +
				`range a deck edge can be — one of those two corners is probably mis-jogged`
			);
		}
	}

	return null;
}

/**
 * Least-squares affine fit of the four taught corners onto the unit square.
 *
 * Four points give 8 equations for 6 unknowns, so the system is overdetermined
 * and there is generally no exact solution — which is the point. The residual
 * is the measurement: it tells the operator whether those four points actually
 * describe one rectangle.
 *
 * Solved in closed form. With the unit square's symmetric corner coordinates the
 * normal equations decouple into the same small 3x3 for x and for y, and that
 * 3x3 is constant, so this reduces to three dot products per axis:
 *
 *   a = mean over corners of (value)                 → the centre
 *   b = mean of (value * (2u - 1))                   → the u slope
 *   c = mean of (value * (2v - 1))                   → the v slope
 *
 * (2u-1 and 2v-1 are +/-1 at the corners and orthogonal over the four of them,
 * which is what makes the normal matrix diagonal and the fit exact to write out.)
 */
export function fitAffine(corners: Corner[]): {
	origin: Point2;
	uAxis: Point2;
	vAxis: Point2;
	residualMm: number;
} {
	const pts = CORNER_LABELS.map((l) => corners.find((k) => k.label === l) as Corner);

	const fitAxis = (get: (c: Corner) => number) => {
		let a = 0;
		let b = 0;
		let c = 0;
		for (const p of pts) {
			const unit = UNIT_SQUARE[p.label];
			const su = 2 * unit.x - 1;
			const sv = 2 * unit.y - 1;
			const val = get(p);
			a += val;
			b += val * su;
			c += val * sv;
		}
		// Centre value, and the half-span along each unit axis.
		return { centre: a / 4, halfU: b / 4, halfV: c / 4 };
	};

	const fx = fitAxis((p) => p.x);
	const fy = fitAxis((p) => p.y);

	// centre + halfU*(2u-1) + halfV*(2v-1)  ⇒  origin at u=v=0, axes over 0→1.
	const uAxis = { x: 2 * fx.halfU, y: 2 * fy.halfU };
	const vAxis = { x: 2 * fx.halfV, y: 2 * fy.halfV };
	const origin = {
		x: fx.centre - fx.halfU - fx.halfV,
		y: fy.centre - fy.halfU - fy.halfV
	};

	// Residual: worst corner's distance from where the fit puts it.
	let residualMm = 0;
	for (const p of pts) {
		const unit = UNIT_SQUARE[p.label];
		const px = origin.x + unit.x * uAxis.x + unit.y * vAxis.x;
		const py = origin.y + unit.x * uAxis.y + unit.y * vAxis.y;
		residualMm = Math.max(residualMm, Math.hypot(px - p.x, py - p.y));
	}

	return { origin, uAxis, vAxis, residualMm };
}

/**
 * Derive the full frame from four taught corners.
 *
 * Throws on invalid corners rather than returning a degenerate frame — callers
 * should run validateCorners() first to get the operator-facing message; the
 * throw is the backstop for a caller that forgets.
 */
export function deriveFrame(corners: Corner[]): DeckFrameDerived {
	const invalid = validateCorners(corners);
	if (invalid) throw new Error(invalid);

	const { origin, uAxis, vAxis, residualMm } = fitAffine(corners);

	const width = Math.hypot(uAxis.x, uAxis.y);
	const height = Math.hypot(vAxis.x, vAxis.y);
	const rotationDeg = (Math.atan2(uAxis.y, uAxis.x) * 180) / Math.PI;

	// Angle between the two edges; 90° is square, so report the departure.
	const dot = uAxis.x * vAxis.x + uAxis.y * vAxis.y;
	const angleDeg = (Math.acos(Math.max(-1, Math.min(1, dot / (width * height)))) * 180) / Math.PI;

	const zs = corners.map((c) => c.z);

	return {
		origin,
		uAxis,
		vAxis,
		width,
		height,
		rotationDeg,
		squarenessDeg: Math.abs(90 - angleDeg),
		residualMm,
		surfaceZ: zs.reduce((s, z) => s + z, 0) / zs.length
	};
}

/**
 * Absolute mm → fraction of the deck.
 *
 * Inverts the 2x2 [uAxis vAxis] matrix. The determinant is the deck's signed
 * area, which validateCorners has already established is non-degenerate, but it
 * is checked anyway: this is the one place a divide-by-zero would produce
 * Infinity and silently poison a stored coordinate.
 */
export function toFrameRelative(
	frame: DeckFrameDerived,
	point: Point2
): { u: number; v: number } | null {
	const det = frame.uAxis.x * frame.vAxis.y - frame.uAxis.y * frame.vAxis.x;
	if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;

	const dx = point.x - frame.origin.x;
	const dy = point.y - frame.origin.y;

	const u = (dx * frame.vAxis.y - dy * frame.vAxis.x) / det;
	const v = (dy * frame.uAxis.x - dx * frame.uAxis.y) / det;

	return Number.isFinite(u) && Number.isFinite(v) ? { u, v } : null;
}

/** Fraction of the deck → absolute mm. The forward map; always defined. */
export function fromFrameRelative(
	frame: DeckFrameDerived,
	rel: { u: number; v: number }
): Point2 | null {
	const u = finite(rel?.u);
	const v = finite(rel?.v);
	if (u === undefined || v === undefined) return null;
	return {
		x: frame.origin.x + u * frame.uAxis.x + v * frame.vAxis.x,
		y: frame.origin.y + u * frame.uAxis.y + v * frame.vAxis.y
	};
}

/**
 * Is this fraction inside the deck the corners describe?
 *
 * Used to sanity-check a calibrator point before storing it relative to the
 * frame. The tolerance is generous because the calibrator fixture legitimately
 * sits at or just past the deck edge on some robots — this catches a point on
 * the far side of the machine, not one a few mm proud of the plate.
 */
export function withinFrame(rel: { u: number; v: number }, tolerance = 0.25): boolean {
	const u = finite(rel?.u);
	const v = finite(rel?.v);
	if (u === undefined || v === undefined) return false;
	return u >= -tolerance && u <= 1 + tolerance && v >= -tolerance && v <= 1 + tolerance;
}

/**
 * How far a re-derive would move the calibrator before we refuse to apply it
 * silently, in mm.
 *
 * Re-teaching the corners after reseating a deck legitimately moves the
 * calibrator by a few mm. Moving it by more than this means the new frame
 * disagrees with the old one about where the deck IS, and applying that without
 * asking would walk a production value across the deck on the strength of four
 * jogs nobody has checked. Over the threshold the operator confirms explicitly.
 */
export const MAX_SILENT_REDERIVE_MM = 10;
