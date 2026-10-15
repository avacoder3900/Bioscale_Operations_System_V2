import { describe, it, expect } from 'vitest';
import {
	ZT230_2X_075_DEFAULTS,
	buildAlignmentZpl,
	buildCartridgeLabelsZpl,
	computeGeometry
} from './cartridge-label-zpl';

const U1 = '5da7b3c5-4cba-4fe4-93b1-c17ad61efbbf';
const U2 = '0f3a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1b0c';
const U3 = '11111111-2222-4333-8444-555555555555';

describe('computeGeometry (ZT230 2-across 150×160 dots @203dpi — ruler-measured 2026-08-18)', () => {
	it('fits the whole design inside a 150×160 dot label', () => {
		const g = computeGeometry(ZT230_2X_075_DEFAULTS);
		expect(g.labelW).toBe(150);
		expect(g.labelH).toBe(160);
		expect(g.gap).toBe(31);
		expect(g.printWidth).toBe(150 * 2 + 31 + 8); // negative x offset → ^LS, adds nothing to ^PW
		expect(g.qrSize).toBe(33 * 3);
		expect(g.qrLeft).toBeGreaterThanOrEqual(0);
		expect(g.qrLeft + g.qrSize).toBeLessThanOrEqual(g.labelW);
		expect(g.textLines).toBe(2);
		const textBottom = g.textTop + Math.round(g.textFont * 1.1) * 2;
		expect(textBottom).toBeLessThanOrEqual(g.labelH);
		// an 18-character line (at most 2 hyphens) ends inside the label
		const lineEnd = g.textLeft + 16 * g.charPitch + 2 * g.hyphenPitch;
		expect(lineEnd).toBeLessThanOrEqual(g.labelW);
	});

	it('uses the 2026-09-22 bench values: QR at 28, 12-dot UDI, x -16 / y -14', () => {
		const g = computeGeometry(ZT230_2X_075_DEFAULTS);
		expect(g.qrTop).toBe(28);
		expect(g.textFont).toBe(12);
		expect(g.textTop).toBe(129);
		expect(g.textLeft).toBe(g.qrLeft - 3);
		expect(g.charPitch).toBeCloseTo(7.3, 1);
		expect(g.hyphenPitch).toBeCloseTo(6.5, 1);
		expect(ZT230_2X_075_DEFAULTS.offsetX).toBe(-16);
		expect(ZT230_2X_075_DEFAULTS.offsetY).toBe(-14);
	});

	it('drops the human-readable text when the QR leaves no room', () => {
		const g = computeGeometry({ ...ZT230_2X_075_DEFAULTS, qrMagnification: 4 });
		expect(g.textLines).toBe(0);
		// and with the marks off a mag-4 QR still fits the label
		const g2 = computeGeometry({ ...ZT230_2X_075_DEFAULTS, qrMagnification: 4, abcMarks: false });
		expect(g2.qrTop + g2.qrSize).toBeLessThanOrEqual(g2.labelH);
	});

	it('scales with dpi', () => {
		const g = computeGeometry({ ...ZT230_2X_075_DEFAULTS, dpi: 300 });
		expect(g.labelW).toBe(222);
	});
});

describe('buildCartridgeLabelsZpl', () => {
	it('emits one ^XA…^XZ format per row of two labels', () => {
		const job = buildCartridgeLabelsZpl([U1, U2, U3]);
		expect(job.rows).toBe(2);
		expect(job.labels).toBe(3);
		expect(job.zpl.match(/\^XA/g)?.length).toBe(2);
		expect(job.zpl.match(/\^XZ/g)?.length).toBe(2);
		// each barcode appears exactly once as a QR payload
		for (const u of [U1, U2, U3]) {
			expect(job.zpl.match(new RegExp(`\\^FDMA,${u}\\^FS`, 'g'))?.length).toBe(1);
		}
	});

	it('places the second column at label width + gap', () => {
		const job = buildCartridgeLabelsZpl([U1, U2], { ...ZT230_2X_075_DEFAULTS, offsetX: 7 });
		const g = job.geometry;
		const pitch = g.labelW + g.gap;
		expect(job.zpl).toContain(`^FO${g.qrLeft + 7},${g.qrTop}^BQN,2,3^FDMA,${U1}`);
		expect(job.zpl).toContain(`^FO${pitch + g.qrLeft + 7},${g.qrTop}^BQN,2,3^FDMA,${U2}`);
	});

	it('applies x offset to every field and y offset via ^LT (clamped to ±120)', () => {
		const job = buildCartridgeLabelsZpl([U1], { ...ZT230_2X_075_DEFAULTS, offsetX: 7, offsetY: -1000 });
		const g = job.geometry;
		expect(job.zpl).toContain(`^FO${g.qrLeft + 7},${g.qrTop}^BQN`);
		expect(job.zpl).toContain('^LT-120');
		const up = buildCartridgeLabelsZpl([U1], { ...ZT230_2X_075_DEFAULTS, offsetY: -8 });
		expect(up.zpl).toContain('^LT-8');
		const left = buildCartridgeLabelsZpl([U1], { ...ZT230_2X_075_DEFAULTS, offsetX: -6 });
		expect(left.zpl).toContain('^LS6');
		expect(left.zpl).toContain(`^FO${g.qrLeft},${g.qrTop}^BQN`); // fields not clamped/shifted (x<0 → ^LS)
		const none = buildCartridgeLabelsZpl([U1], { ...ZT230_2X_075_DEFAULTS, offsetY: 0 });
		expect(none.zpl).not.toContain('^LT');
		const dflt = buildCartridgeLabelsZpl([U1]).zpl; // calibrated defaults 2026-09-22
		expect(dflt).toContain('^LT-14');
		expect(dflt).toContain('^LS16');
	});

	it('sets print width, label length and header commands once per format', () => {
		const job = buildCartridgeLabelsZpl([U1], { ...ZT230_2X_075_DEFAULTS, darkness: 22, printSpeedIps: 4 });
		expect(job.zpl.startsWith('~SD22')).toBe(true);
		expect(job.zpl).toContain('^PW339');
		expect(job.zpl).toContain('^LL160');
		expect(job.zpl).toContain('^PR4');
		expect(job.zpl).toContain('^PQ1^XZ');
	});

	it('prints the UUID as two lines of individually placed, fixed-pitch characters', () => {
		const job = buildCartridgeLabelsZpl([U1]);
		const g = job.geometry;
		// 36 single-character text fields in the 12-dot font, no ^FB blocks
		expect(job.zpl.match(/\^A0N,12,11\^FD.\^FS/g)?.length).toBe(36);
		expect(job.zpl).not.toContain('^FB');
		// line 1 starts at textLeft, second char one pitch on; line 2 is 13 dots lower
		expect(job.zpl).toContain(`^FO${g.textLeft},${g.textTop}^A0N,12,11^FD${U1[0]}^FS`);
		expect(job.zpl).toContain(`^FO${Math.round(g.textLeft + g.charPitch)},${g.textTop}^A0N,12,11^FD${U1[1]}^FS`);
		expect(job.zpl).toContain(`^FO${Math.round(g.textLeft + g.hyphenNudge)},${g.textTop + 13}^A0N,12,11^FD-^FS`); // line 2 of U1 starts with '-'
		// the hyphen at index 8 is nudged right and the digit after it advances by the narrower hyphen pitch
		const hx = g.textLeft + 8 * g.charPitch;
		expect(job.zpl).toContain(`^FO${Math.round(hx + g.hyphenNudge)},${g.textTop}^A0N,12,11^FD-^FS`);
		expect(job.zpl).toContain(`^FO${Math.round(hx + g.hyphenPitch)},${g.textTop}^A0N,12,11^FD${U1[9]}^FS`);
	});

	it('refuses payloads that could inject ZPL', () => {
		expect(() => buildCartridgeLabelsZpl(['abc^XZ~JA'])).toThrow(/unsafe/);
		expect(() => buildCartridgeLabelsZpl([''])).toThrow(/unsafe/);
	});

	it('honours abcMarks=false / humanReadable=false', () => {
		const job = buildCartridgeLabelsZpl([U1], { ...ZT230_2X_075_DEFAULTS, abcMarks: false, humanReadable: false });
		expect(job.zpl).not.toContain('^FDA^FS');
		expect(job.zpl).not.toMatch(/\^A0N,12,11/);
		expect(job.zpl).toContain(`^FDMA,${U1}`);
	});
});

describe('buildAlignmentZpl', () => {
	it('draws a border box for every column and mints nothing', () => {
		const job = buildAlignmentZpl();
		expect(job.rows).toBe(1);
		expect(job.labels).toBe(2);
		expect(job.zpl.match(/\^GB150,160,1\^FS/g)?.length).toBe(2);
		expect(job.zpl).toContain('ALIGN 1');
		expect(job.zpl).toContain('ALIGN 2');
	});
});
