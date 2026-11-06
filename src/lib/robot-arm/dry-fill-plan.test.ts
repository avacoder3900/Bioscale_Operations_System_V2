import { describe, expect, it } from 'vitest';
import { liquidHeight, planBatches, planDryFill, tubeDepthFor, type DryFillInput } from './dry-fill-plan';
import { stageTargets } from './stage-geometry';

// B07 on 2026-11-06: Wax_Filling_GEN7_ArmStage.py defaults, drybath tuberack A3 depth 38.6 mm.
const holes = stageTargets(100, 100, 50).map((h) => ({ name: h.name, gate: h.gate }));
const b07: DryFillInput = {
	holes,
	gateVolumes: { 1: 1.6, 2: 1.6, 3: 1.6, 4: 1.6 },
	aspirateRemainder: 11.5,
	minTipClearanceMm: 1.5,
	tubeDepthMm: 38.6
};

describe('dry fill plan (port of Wax_Filling_GEN7_ArmStage.py)', () => {
	it('interpolates the 2 mL tube table as the protocol does (bisect_left segment)', () => {
		expect(liquidHeight(100)).toBeCloseTo(4.15, 6);
		// 51.3 µL sits in the 100-150 segment by bisect_left: 4.15 + 1.5 × (51.3 − 100) / 50.
		expect(liquidHeight(51.3)).toBeCloseTo(2.689, 6);
		expect(liquidHeight(44.9)).toBeCloseTo(3.7643, 6);
	});

	it('one batch per row, never across a row', () => {
		const batches = planBatches(b07);
		expect(batches.map((b) => b.map((h) => h.name))).toEqual([
			['X2', 'X4', 'X6', 'X8'],
			['W2', 'W4', 'W6', 'W8'],
			['V2', 'V4', 'V6', 'V8']
		]);
	});

	it('aspirate depths match the protocol (python: 37.1, 36.8357, 36.8805)', () => {
		const plan = planDryFill(b07);
		expect(plan.cartVolume).toBeCloseTo(19.2, 6);
		expect(plan.batches.map((b) => b.aspirateVolume)).toEqual([17.9, 17.9, 17.9]);
		expect(plan.batches[0].aspirateBelowRimMm).toBeCloseTo(37.1, 3); // clamped to the floor
		expect(plan.batches[1].aspirateBelowRimMm).toBeCloseTo(36.836, 3);
		expect(plan.batches[2].aspirateBelowRimMm).toBeCloseTo(36.881, 3);
	});

	it('clamps the aspirate to tube bottom + min_tip_clearance', () => {
		expect(tubeDepthFor({ tubeDepthMm: 38.6, minTipClearanceMm: 3 }, 69.2, 17.9)).toBeCloseTo(35.6, 6);
	});

	it('never picks up or drops a tip, and ends all the way up', () => {
		const { steps } = planDryFill(b07);
		expect(steps.some((s) => (s.op as string) === 'pickUpTip' || (s.op as string) === 'dropTip')).toBe(false);
		expect(steps[steps.length - 1]).toEqual({ op: 'lift' });
	});

	it('each hole: prejump, dispense height, dispense at 0.325 × 7.56 µL/s; first hole of a row planned after a lift', () => {
		const { steps } = planDryFill(b07);
		const holeSteps = steps.filter((s) => s.op === 'hole');
		expect(holeSteps).toHaveLength(24);
		const x2 = steps.findIndex((s) => s.op === 'hole' && s.name === 'X2' && s.at === 'prejump');
		expect(steps[x2 - 1]).toEqual({ op: 'lift' });
		expect(steps[x2]).toMatchObject({ planned: true });
		const x4 = steps.findIndex((s) => s.op === 'hole' && s.name === 'X4' && s.at === 'prejump');
		expect(steps[x4]).toMatchObject({ planned: false });
		expect(steps[x2 + 3]).toEqual({ op: 'dispense', volume: 1.6, flowRate: 2.457 });
	});

	it('every batch: tube top, prepare, aspirate, settle with touch tip and 0.25 µL drip, blow out at the tube top', () => {
		const { steps } = planDryFill(b07);
		expect(steps.slice(0, 11)).toEqual([
			{ op: 'lift' },
			{ op: 'tube', belowRimMm: 0 },
			{ op: 'prepare' },
			{ op: 'tube', belowRimMm: 37.1 },
			{ op: 'aspirate', volume: 17.9, flowRate: 7.56 },
			{ op: 'delay', seconds: 2 },
			{ op: 'tube', belowRimMm: 2.3 },
			{ op: 'delay', seconds: 3 },
			{ op: 'touchTip', belowRimMm: 2.3, radius: 1, speed: 60 },
			{ op: 'tube', belowRimMm: 0 },
			{ op: 'dispense', volume: 0.25, flowRate: 3.78 }
		]);
		expect(steps.filter((s) => s.op === 'blowOut')).toHaveLength(3);
		expect(steps.filter((s) => s.op === 'aspirate')).toHaveLength(3);
	});

	it('refuses a hole that needs more than one aspiration holds', () => {
		expect(() => planBatches({ ...b07, gateVolumes: { 1: 9, 2: 1.6, 3: 1.6, 4: 1.6 } })).toThrow(/usable per aspiration/);
	});
});
