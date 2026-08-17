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

describe('computeGeometry (ZT230 2-across ¾" @203dpi)', () => {
	it('fits the whole design inside a 152×152 dot label', () => {
		const g = computeGeometry(ZT230_2X_075_DEFAULTS);
		expect(g.labelW).toBe(152);
		expect(g.labelH).toBe(152);
		expect(g.gap).toBe(25);
		expect(g.printWidth).toBe(152 * 2 + 25);
		expect(g.qrSize).toBe(33 * 3);
		expect(g.qrLeft).toBeGreaterThanOrEqual(0);
		expect(g.qrLeft + g.qrSize).toBeLessThanOrEqual(g.labelW);
		expect(g.textLines).toBe(2);
		const textBottom = g.textTop + Math.round(g.textFont * 1.1) * 2;
		expect(textBottom).toBeLessThanOrEqual(g.labelH);
	});

	it('drops the human-readable text when the QR leaves no room', () => {
		const g = computeGeometry({ ...ZT230_2X_075_DEFAULTS, qrMagnification: 4 });
		expect(g.qrTop + g.qrSize).toBeLessThanOrEqual(g.labelH);
		expect(g.textLines).toBe(0);
	});

	it('scales with dpi', () => {
		const g = computeGeometry({ ...ZT230_2X_075_DEFAULTS, dpi: 300 });
		expect(g.labelW).toBe(225);
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
		const job = buildCartridgeLabelsZpl([U1, U2]);
		const g = job.geometry;
		const pitch = g.labelW + g.gap;
		expect(job.zpl).toContain(`^FO${g.qrLeft},${g.qrTop}^BQN,2,3^FDMA,${U1}`);
		expect(job.zpl).toContain(`^FO${pitch + g.qrLeft},${g.qrTop}^BQN,2,3^FDMA,${U2}`);
	});

	it('applies x/y offsets to every field and clamps at zero', () => {
		const job = buildCartridgeLabelsZpl([U1], { ...ZT230_2X_075_DEFAULTS, offsetX: 7, offsetY: -1000 });
		const g = job.geometry;
		expect(job.zpl).toContain(`^FO${g.qrLeft + 7},0^BQN`);
	});

	it('sets print width, label length and header commands once per format', () => {
		const job = buildCartridgeLabelsZpl([U1], { ...ZT230_2X_075_DEFAULTS, darkness: 22, printSpeedIps: 4 });
		expect(job.zpl.startsWith('~SD22')).toBe(true);
		expect(job.zpl).toContain('^PW329');
		expect(job.zpl).toContain('^LL152');
		expect(job.zpl).toContain('^PR4');
		expect(job.zpl).toContain('^PQ1^XZ');
	});

	it('splits the UUID into two centred human-readable lines', () => {
		const job = buildCartridgeLabelsZpl([U1]);
		expect(job.zpl).toContain(`^FD${U1.slice(0, 18)}^FS`);
		expect(job.zpl).toContain(`^FD${U1.slice(18)}^FS`);
		expect(job.zpl).toContain('^FB152,1,0,C,0');
	});

	it('refuses payloads that could inject ZPL', () => {
		expect(() => buildCartridgeLabelsZpl(['abc^XZ~JA'])).toThrow(/unsafe/);
		expect(() => buildCartridgeLabelsZpl([''])).toThrow(/unsafe/);
	});

	it('honours abcMarks=false / humanReadable=false', () => {
		const job = buildCartridgeLabelsZpl([U1], { ...ZT230_2X_075_DEFAULTS, abcMarks: false, humanReadable: false });
		expect(job.zpl).not.toContain('^FDA^FS');
		expect(job.zpl).not.toContain('^FB');
		expect(job.zpl).toContain(`^FDMA,${U1}`);
	});
});

describe('buildAlignmentZpl', () => {
	it('draws a border box for every column and mints nothing', () => {
		const job = buildAlignmentZpl();
		expect(job.rows).toBe(1);
		expect(job.labels).toBe(2);
		expect(job.zpl.match(/\^GB152,152,1\^FS/g)?.length).toBe(2);
		expect(job.zpl).toContain('ALIGN 1');
		expect(job.zpl).toContain('ALIGN 2');
	});
});
