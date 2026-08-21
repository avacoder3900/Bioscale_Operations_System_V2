/**
 * Deck-frame geometry: the fit, and every way four taught points can be wrong.
 *
 * Same brief as tip-calibrator.test.ts — these are guards on numbers that end up
 * commanding a real pipette, so the interesting cases here are the degenerate
 * ones. A frame derived from bad corners does not look broken: it produces
 * perfectly finite coordinates that are simply in the wrong place, and the first
 * thing that notices is the tip. Every rejection below is a mis-jog that would
 * otherwise have been stored as fact.
 *
 * What these tests CANNOT tell you is whether the four points the operator
 * jogged to are actually the deck's corners. That needs the plate on the wire.
 */
import { describe, it, expect } from 'vitest';
import {
	CORNER_LABELS,
	DECK_EDGE_LIMITS,
	MAX_RESIDUAL_MM,
	MAX_SILENT_REDERIVE_MM,
	deriveFrame,
	fitAffine,
	fromFrameRelative,
	toFrameRelative,
	validateCorners,
	withinFrame,
	type Corner
} from './deck-frame';

/** A clean 300 x 200 deck sitting square at the origin. */
const square = (): Corner[] => [
	{ label: 'FL', x: 0, y: 0, z: 10 },
	{ label: 'FR', x: 300, y: 0, z: 10 },
	{ label: 'BR', x: 300, y: 200, z: 10 },
	{ label: 'BL', x: 0, y: 200, z: 10 }
];

/** The same deck, offset and rotated in its seat — the case the frame exists for. */
const rotated = (deg: number, dx = 0, dy = 0): Corner[] => {
	const r = (deg * Math.PI) / 180;
	const [c, s] = [Math.cos(r), Math.sin(r)];
	return square().map((k) => ({
		...k,
		x: k.x * c - k.y * s + dx,
		y: k.x * s + k.y * c + dy
	}));
};

describe('validateCorners', () => {
	it('accepts a clean rectangle', () => {
		expect(validateCorners(square())).toBeNull();
	});

	it('accepts a rotated, offset deck — that is the whole point', () => {
		expect(validateCorners(rotated(7, 120, 45))).toBeNull();
	});

	it('rejects a partial teach and says which corner is missing', () => {
		const three = square().filter((k) => k.label !== 'BR');
		expect(validateCorners(three)).toMatch(/four deck corners/i);

		const nulled = square().map((k) => (k.label === 'BR' ? { ...k, label: 'FL' as const } : k));
		expect(validateCorners(nulled)).toMatch(/back-right/i);
	});

	it('rejects a corner with a non-numeric axis rather than reading it as 0', () => {
		const bad = square().map((k) => (k.label === 'FR' ? { ...k, y: NaN } : k));
		expect(validateCorners(bad)).toMatch(/front-right.*no y reading/i);

		const missing = square().map((k) =>
			k.label === 'BL' ? ({ ...k, z: undefined } as unknown as Corner) : k
		);
		expect(validateCorners(missing)).toMatch(/back-left.*no z reading/i);
	});

	it('rejects two corners taught at the same place', () => {
		const collapsed = square().map((k) => (k.label === 'FR' ? { ...k, x: 0, y: 0 } : k));
		expect(validateCorners(collapsed)).toMatch(/same place/i);
	});

	it('rejects a bow-tie from two corners captured into swapped slots', () => {
		const c = square();
		const fr = { ...c[1] };
		const br = { ...c[2] };
		const swapped = [c[0], { ...br, label: 'FR' as const }, { ...fr, label: 'BR' as const }, c[3]];
		expect(validateCorners(swapped)).toMatch(/cross over/i);
	});

	it('rejects an edge outside the plausible deck-size window', () => {
		const tiny = square().map((k) =>
			k.label === 'FR' || k.label === 'BR' ? { ...k, x: DECK_EDGE_LIMITS.min - 5 } : k
		);
		expect(validateCorners(tiny)).toMatch(/mis-jogged/i);

		const huge = square().map((k) =>
			k.label === 'FR' || k.label === 'BR' ? { ...k, x: DECK_EDGE_LIMITS.max + 50 } : k
		);
		expect(validateCorners(huge)).toMatch(/mis-jogged/i);
	});

	it('rejects non-array input instead of throwing', () => {
		expect(validateCorners(null)).toMatch(/four deck corners/i);
		expect(validateCorners('FL,FR,BR,BL')).toMatch(/four deck corners/i);
	});
});

describe('deriveFrame', () => {
	it('recovers the axes of a square deck exactly', () => {
		const f = deriveFrame(square());
		expect(f.origin.x).toBeCloseTo(0, 9);
		expect(f.origin.y).toBeCloseTo(0, 9);
		expect(f.uAxis.x).toBeCloseTo(300, 9);
		expect(f.uAxis.y).toBeCloseTo(0, 9);
		expect(f.vAxis.x).toBeCloseTo(0, 9);
		expect(f.vAxis.y).toBeCloseTo(200, 9);
		expect(f.width).toBeCloseTo(300, 9);
		expect(f.height).toBeCloseTo(200, 9);
		expect(f.rotationDeg).toBeCloseTo(0, 9);
		expect(f.squarenessDeg).toBeCloseTo(0, 9);
		expect(f.residualMm).toBeCloseTo(0, 9);
	});

	it('reports rotation and keeps the deck dimensions', () => {
		const f = deriveFrame(rotated(12, 50, -30));
		expect(f.rotationDeg).toBeCloseTo(12, 6);
		expect(f.width).toBeCloseTo(300, 6);
		expect(f.height).toBeCloseTo(200, 6);
		expect(f.squarenessDeg).toBeCloseTo(0, 6);
		// A rigid rotation is still exactly a rectangle — nothing to blame on the fit.
		expect(f.residualMm).toBeCloseTo(0, 6);
		expect(f.origin.x).toBeCloseTo(50, 6);
		expect(f.origin.y).toBeCloseTo(-30, 6);
	});

	it('averages the corner heights into surfaceZ', () => {
		const tilted = square().map((k, i) => ({ ...k, z: 10 + i })); // 10,11,12,13
		expect(deriveFrame(tilted).surfaceZ).toBeCloseTo(11.5, 9);
	});

	it('leaves exactly a quarter of a single mis-jogged corner in the residual', () => {
		// THE property MAX_RESIDUAL_MM is calibrated against, so it is pinned here
		// rather than merely bounded. Six of the eight constraints go into fitting
		// the rectangle, so the fit absorbs 3/4 of a lone displaced corner and the
		// residual reports the remaining 1/4. Anyone reading residual as "how far
		// the corner was off" is wrong by 4x — and would set the threshold 4x too
		// loose, which is the mistake this test exists to prevent.
		for (const err of [4, 8, 20]) {
			const bent = square().map((k) => (k.label === 'BR' ? { ...k, x: k.x + err } : k));
			expect(deriveFrame(bent).residualMm).toBeCloseTo(err / 4, 6);
		}
	});

	it('refuses a corner mis-jogged by more than 4 mm, and tolerates teach slop', () => {
		const bent = square().map((k) => (k.label === 'BR' ? { ...k, x: k.x + 5 } : k));
		expect(deriveFrame(bent).residualMm).toBeGreaterThan(MAX_RESIDUAL_MM);

		// Realistic per-corner slop (sub-mm, independent) must stay well clear of
		// the threshold or the frame becomes un-teachable in practice.
		const sloppy = square().map((k, i) => ({
			...k,
			x: k.x + [0.3, -0.4, 0.2, -0.1][i],
			y: k.y + [-0.2, 0.3, -0.3, 0.4][i]
		}));
		expect(deriveFrame(sloppy).residualMm).toBeLessThan(MAX_RESIDUAL_MM / 2);
	});

	it('reports a parallelogram through squarenessDeg', () => {
		// Shear the back edge right by 40 mm: still convex, still a valid quad,
		// but no longer square in its seat.
		const sheared = square().map((k) =>
			k.label === 'BL' || k.label === 'BR' ? { ...k, x: k.x + 40 } : k
		);
		const f = deriveFrame(sheared);
		expect(f.squarenessDeg).toBeGreaterThan(5);
		// A parallelogram IS exactly representable by an affine map, so the fit is
		// perfect — squareness is the only thing that can flag it.
		expect(f.residualMm).toBeCloseTo(0, 6);
	});

	it('throws rather than returning a degenerate frame', () => {
		expect(() => deriveFrame(square().slice(0, 3))).toThrow(/four deck corners/i);
	});
});

describe('frame-relative round trip', () => {
	it('maps the corners onto the unit square', () => {
		const f = deriveFrame(square());
		const expected: Record<string, { u: number; v: number }> = {
			FL: { u: 0, v: 0 },
			FR: { u: 1, v: 0 },
			BR: { u: 1, v: 1 },
			BL: { u: 0, v: 1 }
		};
		for (const label of CORNER_LABELS) {
			const c = square().find((k) => k.label === label)!;
			const rel = toFrameRelative(f, c)!;
			expect(rel.u).toBeCloseTo(expected[label].u, 9);
			expect(rel.v).toBeCloseTo(expected[label].v, 9);
		}
	});

	it('round-trips an arbitrary point through a rotated frame', () => {
		const f = deriveFrame(rotated(23, -80, 140));
		const point = { x: 12.5, y: 91.75 };
		const rel = toFrameRelative(f, point)!;
		const back = fromFrameRelative(f, rel)!;
		expect(back.x).toBeCloseTo(point.x, 6);
		expect(back.y).toBeCloseTo(point.y, 6);
	});

	it('re-derives a point onto a shifted deck — the reseat case', () => {
		// Teach the calibrator on a deck, then reseat that deck 15 mm right and
		// 4 mm back and re-teach the corners. The relative position is unchanged,
		// so the absolute must follow the deck by exactly that shift.
		const before = deriveFrame(square());
		const calibrator = { x: 125.181, y: 173.247 };
		const rel = toFrameRelative(before, calibrator)!;

		const after = deriveFrame(square().map((k) => ({ ...k, x: k.x + 15, y: k.y + 4 })));
		const moved = fromFrameRelative(after, rel)!;

		expect(moved.x).toBeCloseTo(calibrator.x + 15, 6);
		expect(moved.y).toBeCloseTo(calibrator.y + 4, 6);
	});

	it('returns null rather than Infinity on a degenerate frame', () => {
		const collapsed = { ...deriveFrame(square()), vAxis: { x: 0, y: 0 } };
		expect(toFrameRelative(collapsed, { x: 1, y: 1 })).toBeNull();
	});

	it('returns null for a non-numeric relative coordinate', () => {
		const f = deriveFrame(square());
		expect(fromFrameRelative(f, { u: NaN, v: 0.5 })).toBeNull();
		expect(fromFrameRelative(f, { u: 0.5, v: undefined as unknown as number })).toBeNull();
	});
});

describe('withinFrame', () => {
	it('accepts points on the deck and just off its edge', () => {
		expect(withinFrame({ u: 0.5, v: 0.5 })).toBe(true);
		expect(withinFrame({ u: 0, v: 1 })).toBe(true);
		// The calibrator legitimately sits slightly proud of the plate on some robots.
		expect(withinFrame({ u: 1.1, v: 0.5 })).toBe(true);
	});

	it('rejects a point on the far side of the machine', () => {
		expect(withinFrame({ u: 3, v: 0.5 })).toBe(false);
		expect(withinFrame({ u: 0.5, v: -2 })).toBe(false);
	});

	it('rejects non-numeric input rather than coercing it', () => {
		expect(withinFrame({ u: NaN, v: 0.5 })).toBe(false);
	});
});

describe('fitAffine', () => {
	it('is exact for any rigid transform of a rectangle', () => {
		for (const deg of [0, 15, 45, 90, 137, -30]) {
			expect(fitAffine(rotated(deg, 10, -20)).residualMm).toBeLessThan(1e-6);
		}
	});
});

describe('thresholds', () => {
	it('keeps the silent re-derive limit tighter than a plausible deck edge', () => {
		// A re-derive that moves the calibrator further than this needs a human.
		expect(MAX_SILENT_REDERIVE_MM).toBeLessThan(DECK_EDGE_LIMITS.min);
		expect(MAX_RESIDUAL_MM).toBeLessThan(MAX_SILENT_REDERIVE_MM);
	});
});
