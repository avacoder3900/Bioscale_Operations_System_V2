import { describe, expect, it } from 'vitest';
import {
	assessMarkers,
	colorMatcher,
	describeVision,
	hexToRgb,
	hueDistance,
	isLowSaturation,
	rgbToHex,
	rgbToHsv,
	samplePatch,
	trackAll,
	trackMarker,
	type PixelImage,
	type Placement,
	type Rgb
} from './markers';

const RED: Rgb = { r: 220, g: 30, b: 40 };
const GREEN: Rgb = { r: 40, g: 200, b: 60 };
const GREY_BG: Rgb = { r: 90, g: 90, b: 95 };

/** A W×H RGB(A) frame with filled discs painted on a grey background. */
function frame(w: number, h: number, discs: { x: number; y: number; r: number; c: Rgb }[], channels: 3 | 4 = 3): PixelImage {
	const data = new Uint8ClampedArray(w * h * channels);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let c = GREY_BG;
			for (const d of discs) if ((x - d.x) ** 2 + (y - d.y) ** 2 <= d.r * d.r) c = d.c;
			const i = (y * w + x) * channels;
			data[i] = c.r;
			data[i + 1] = c.g;
			data[i + 2] = c.b;
			if (channels === 4) data[i + 3] = 255;
		}
	}
	return { data, width: w, height: h, channels };
}

describe('colour helpers', () => {
	it('rgbToHsv on primaries and grey', () => {
		expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 1 });
		expect(rgbToHsv({ r: 0, g: 255, b: 0 }).h).toBe(120);
		expect(rgbToHsv({ r: 0, g: 0, b: 255 }).h).toBe(240);
		expect(rgbToHsv({ r: 128, g: 128, b: 128 }).s).toBe(0);
	});
	it('hue distance wraps at 360', () => {
		expect(hueDistance(350, 10)).toBe(20);
		expect(hueDistance(10, 350)).toBe(20);
		expect(hueDistance(0, 180)).toBe(180);
	});
	it('hex round trip; garbage → null', () => {
		expect(rgbToHex(RED)).toBe('#dc1e28');
		expect(hexToRgb('#dc1e28')).toEqual(RED);
		expect(hexToRgb('nope')).toBeNull();
	});
	it('saturated stickers match on hue under a lighting change; grey ones fall back to RGB', () => {
		const m = colorMatcher(RED);
		expect(m(220, 30, 40)).toBe(true);
		expect(m(150, 20, 28)).toBe(true); // same red, dimmer
		expect(m(40, 200, 60)).toBe(false);
		expect(m(90, 90, 95)).toBe(false);
		expect(isLowSaturation({ r: 240, g: 240, b: 235 })).toBe(true);
		const w = colorMatcher({ r: 240, g: 240, b: 235 });
		expect(w(235, 238, 230)).toBe(true);
		expect(w(90, 90, 95)).toBe(false);
	});
	it('samplePatch returns the median, ignoring a glare pixel', () => {
		const img = frame(20, 20, [{ x: 10, y: 10, r: 4, c: RED }, { x: 10, y: 10, r: 0, c: { r: 255, g: 255, b: 255 } }]);
		expect(samplePatch(img, 10, 10, 3)).toEqual(RED);
		expect(samplePatch(img, -50, -50, 3)).toBeNull();
	});
});

describe('trackMarker', () => {
	it('finds the sticker centroid from a nearby prior (RGB and RGBA frames)', () => {
		for (const ch of [3, 4] as const) {
			const img = frame(100, 80, [{ x: 40, y: 30, r: 4, c: RED }], ch);
			const t = trackMarker(img, RED, { x: 46, y: 34 }, { searchRadiusPx: 15 })!;
			expect(t.x).toBeCloseTo(40, 0);
			expect(t.y).toBeCloseTo(30, 0);
			expect(t.pixels).toBeGreaterThan(30);
		}
	});
	it('two same-colour stickers in range: takes the one nearest the prior, not their midpoint', () => {
		const img = frame(100, 80, [{ x: 30, y: 40, r: 4, c: RED }, { x: 60, y: 40, r: 4, c: RED }]);
		expect(trackMarker(img, RED, { x: 35, y: 40 }, { searchRadiusPx: 40 })!.x).toBeCloseTo(30, 0);
		expect(trackMarker(img, RED, { x: 55, y: 40 }, { searchRadiusPx: 40 })!.x).toBeCloseTo(60, 0);
	});
	it('out of range, wrong colour, or too small → lost', () => {
		const img = frame(100, 80, [{ x: 80, y: 60, r: 4, c: RED }, { x: 20, y: 20, r: 1, c: RED }]);
		expect(trackMarker(img, RED, { x: 40, y: 40 }, { searchRadiusPx: 10 })).toBeNull();
		expect(trackMarker(img, GREEN, { x: 80, y: 60 }, { searchRadiusPx: 10 })).toBeNull();
		expect(trackMarker(img, RED, { x: 20, y: 20 }, { searchRadiusPx: 5 })).toBeNull();
	});
});

const placements: Placement[] = [
	{ markerId: 'a', name: 'Shoulder', group: 'Joint', color: RED, x: 0.2, y: 0.25, depthMm: 500 },
	{ markerId: 'b', name: 'Claw', group: null, color: GREEN, x: 0.5, y: 0.5, depthMm: 450 },
	{ markerId: 'c', name: 'Deck corner', group: 'Environment', color: { r: 30, g: 60, b: 220 }, x: 0.8, y: 0.75, depthMm: null }
];
const tol = { position: 0.015, depthMm: 20 };

describe('trackAll + assessMarkers', () => {
	it('every sticker where it was calibrated → ok', () => {
		const img = frame(200, 160, placements.map((p) => ({ x: p.x * 200, y: p.y * 160, r: 4, c: p.color })));
		const obs = trackAll(img, placements);
		const a = assessMarkers(placements, obs, tol);
		expect(a.verdict).toBe('ok');
		expect(a.okCount).toBe(3);
		expect(describeVision(a, 200)).toMatch(/All 3 markers/);
	});
	it('one sticker moved, one gone → off, and the sentence names them', () => {
		const img = frame(200, 160, [
			{ x: 40, y: 40, r: 4, c: RED },
			{ x: 112, y: 80, r: 4, c: GREEN } // 12 px right of 100
		]);
		const a = assessMarkers(placements, trackAll(img, placements), tol);
		expect(a.verdict).toBe('off');
		expect(a.markers.map((m) => m.status)).toEqual(['ok', 'moved', 'missing']);
		expect(a.markers[1].distance).toBeCloseTo(0.06, 2);
		expect(describeVision(a, 200)).toMatch(/2 of 3 markers are off: Claw 12 px off, Deck corner not found/);
	});
	it('in place on the picture but nearer the lens → depth_off', () => {
		const obs = placements.map((p) => ({ markerId: p.markerId, x: p.x, y: p.y, depthMm: p.depthMm == null ? null : p.depthMm - 35, pixels: 40 }));
		const a = assessMarkers(placements, obs, tol);
		expect(a.markers.map((m) => m.status)).toEqual(['depth_off', 'depth_off', 'ok']);
		expect(a.depthUsed).toBe(true);
		expect(describeVision(a, 200)).toMatch(/Shoulder -35 mm depth/);
	});
	it('every marker shifted by the same vector → camera_moved', () => {
		const obs = placements.map((p) => ({ markerId: p.markerId, x: p.x + 0.05, y: p.y - 0.03, depthMm: null, pixels: 40 }));
		expect(assessMarkers(placements, obs, tol).verdict).toBe('camera_moved');
		// …but scattered moves are just "off"
		const scattered = obs.map((o, i) => ({ ...o, x: o.x + i * 0.05 }));
		expect(assessMarkers(placements, scattered, tol).verdict).toBe('off');
	});
	it('a prior near the new spot is followed; lost from the prior → retried at the calibrated spot', () => {
		const img = frame(200, 160, [{ x: 60, y: 40, r: 4, c: RED }]);
		const one = [placements[0]];
		expect(trackAll(img, one, { priors: { a: { x: 0.29, y: 0.25 } } })[0].x).toBeCloseTo(0.3, 2);
		const back = frame(200, 160, [{ x: 40, y: 40, r: 4, c: RED }]);
		expect(trackAll(back, one, { priors: { a: { x: 0.9, y: 0.9 } } })[0].x).toBeCloseTo(0.2, 2);
	});
	it('no placements → no_markers', () => {
		expect(assessMarkers([], [], tol).verdict).toBe('no_markers');
	});
});
