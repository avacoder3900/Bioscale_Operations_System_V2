import { describe, expect, it } from 'vitest';
import { DISPENSE_DEPTH_DEFAULT_MM, depthFromLive, dispenseZ, stageTargets } from './stage-geometry';

// Twin of protocols/tests/test_arm_stage_geometry.py — same numbers, same order.
describe('stageTargets', () => {
	const X0 = 200, Y0 = 100, Z0 = 80;

	it('lays out 12 holes in the carriage fill order with the cartridge pitch', () => {
		const t = stageTargets(X0, Y0, Z0);
		expect(t.map((h) => h.name)).toEqual(['X2', 'X4', 'X6', 'X8', 'W2', 'W4', 'W6', 'W8', 'V2', 'V4', 'V6', 'V8']);
		const by = Object.fromEntries(t.map((h) => [h.name, h]));
		expect([by.X2.x, by.X2.y, by.X2.z]).toEqual([X0, Y0, Z0]);
		expect([by.X8.x, by.X8.y]).toEqual([X0 - 18, Y0]);
		expect([by.V2.x, by.V2.y]).toEqual([X0, Y0 - 18]);
		expect([by.V8.x, by.V8.y]).toEqual([X0 - 18, Y0 - 18]);
		expect(t.every((h) => h.z === Z0)).toBe(true);
		expect(by.X2.gate).toBe(4);
		expect(by.X8.gate).toBe(1);
		expect(by.V8.row).toBe(3);
		expect(t.map((h) => h.index)).toEqual([...Array(12).keys()]);
	});

	it('turns the cart about the first hole', () => {
		const r = Object.fromEntries(stageTargets(X0, Y0, Z0, 180).map((h) => [h.name, h]));
		expect([r.X2.x, r.X2.y]).toEqual([X0, Y0]);
		expect([r.X8.x, r.X8.y]).toEqual([X0 + 18, Y0]);
		expect([r.V2.x, r.V2.y]).toEqual([X0, Y0 + 18]);
		const q = Object.fromEntries(stageTargets(X0, Y0, Z0, 90).map((h) => [h.name, h]));
		expect([q.X8.x, q.X8.y]).toEqual([X0, Y0 - 18]);
		expect([q.V2.x, q.V2.y]).toEqual([X0 + 18, Y0]);
	});

	it('keeps the pitch at any rotation', () => {
		for (const rot of [0, 37.5, 180, -90]) {
			const p = Object.fromEntries(stageTargets(X0, Y0, Z0, rot).map((h) => [h.name, h]));
			expect(Math.hypot(p.X2.x - p.X4.x, p.X2.y - p.X4.y)).toBeCloseTo(6, 2);
			expect(Math.hypot(p.X2.x - p.W2.x, p.X2.y - p.W2.y)).toBeCloseTo(9, 2);
		}
	});
});

describe('dispense depth', () => {
	it('is measured down from the rim; the protocol default hovers 1 mm above it', () => {
		expect(dispenseZ(80, null)).toBe(80 - DISPENSE_DEPTH_DEFAULT_MM);
		expect(dispenseZ(80, 1.5)).toBe(78.5);
		expect(depthFromLive(80, 78.5)).toBe(1.5);
		expect(depthFromLive(80, 81)).toBe(-1);
	});
});
