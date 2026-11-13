import { describe, it, expect } from 'vitest';
import { legacyOffsetsFor, lpcTargets, checkLpcOffset } from './lpc-offsets';

// B14's diluent analysis (2026-11-13): 1000 µL tips in 11, the 15-tube Falcon rack in 10,
// heat-frame racks in 7 / 4 / 1.
const analysis = [
	{ loadName: 'opentrons_96_tiprack_1000ul', definitionUri: 'opentrons/opentrons_96_tiprack_1000ul/1', location: { slotName: '11' } },
	{ loadName: 'opentrons_15_tuberack_falcon_15ml_conical', definitionUri: 'opentrons/opentrons_15_tuberack_falcon_15ml_conical/1', location: { slotName: '10' } },
	{ loadName: '3dprinted_2ml_tuberack_heat_frame', definitionUri: 'custom_beta/3dprinted_2ml_tuberack_heat_frame/1', location: { slotName: '7' } },
	{ loadName: '3dprinted_2ml_tuberack_heat_frame', definitionUri: 'custom_beta/3dprinted_2ml_tuberack_heat_frame/1', location: { slotName: '4' } },
	{ loadName: '3dprinted_2ml_tuberack_heat_frame', definitionUri: 'custom_beta/3dprinted_2ml_tuberack_heat_frame/1', location: { slotName: '1' } },
	{ loadName: 'opentrons_1_trash_1100ml_fixed', definitionUri: 'opentrons/opentrons_1_trash_1100ml_fixed/1', location: { slotName: '12' } }
];

describe('legacyOffsetsFor', () => {
	it('sends one run-level offset per labware that has a stored row for its URI in its slot', () => {
		const rows = [
			{ definitionUri: 'opentrons/opentrons_15_tuberack_falcon_15ml_conical/1', slotName: '10', vector: { x: 0.3, y: -0.1, z: -0.4 } },
			{ definitionUri: 'custom_beta/3dprinted_2ml_tuberack_heat_frame/1', slotName: '7', vector: { x: 0, y: 0.2, z: -1.1 } },
			// Same rack, slot 4 — a different row, a different vector.
			{ definitionUri: 'custom_beta/3dprinted_2ml_tuberack_heat_frame/1', slotName: '4', vector: { x: -0.5, y: 0, z: -0.9 } },
			// A row for a slot this run does not use.
			{ definitionUri: 'cosmas_damian/cosmas_and_damian_biotix_96_200ul_tiprack/1', slotName: '11', vector: { x: 0, y: 0, z: -2.3 } }
		];
		expect(legacyOffsetsFor(rows, analysis)).toEqual([
			{ definitionUri: 'opentrons/opentrons_15_tuberack_falcon_15ml_conical/1', location: { slotName: '10' }, vector: { x: 0.3, y: -0.1, z: -0.4 } },
			{ definitionUri: 'custom_beta/3dprinted_2ml_tuberack_heat_frame/1', location: { slotName: '7' }, vector: { x: 0, y: 0.2, z: -1.1 } },
			{ definitionUri: 'custom_beta/3dprinted_2ml_tuberack_heat_frame/1', location: { slotName: '4' }, vector: { x: -0.5, y: 0, z: -0.9 } }
		]);
	});
	it('leaves out zero vectors and is empty with no rows or no analysis', () => {
		const rows = [{ definitionUri: 'custom_beta/3dprinted_2ml_tuberack_heat_frame/1', slotName: '7', vector: { x: 0, y: 0, z: 0 } }];
		expect(legacyOffsetsFor(rows, analysis)).toEqual([]);
		expect(legacyOffsetsFor([], analysis)).toEqual([]);
		expect(legacyOffsetsFor(rows, null)).toEqual([]);
		expect(legacyOffsetsFor(rows, 'nope')).toEqual([]);
	});
});

describe('lpcTargets', () => {
	it('is the slot-based, non-tiprack labware — what the position check measures', () => {
		expect(lpcTargets(analysis).map((t) => `${t.loadName}@${t.slotName}`)).toEqual([
			'opentrons_15_tuberack_falcon_15ml_conical@10',
			'3dprinted_2ml_tuberack_heat_frame@7',
			'3dprinted_2ml_tuberack_heat_frame@4',
			'3dprinted_2ml_tuberack_heat_frame@1',
			'opentrons_1_trash_1100ml_fixed@12'
		]);
		expect(lpcTargets(undefined)).toEqual([]);
	});
});

describe('checkLpcOffset', () => {
	const good = { definitionUri: 'custom_beta/3dprinted_2ml_tuberack_heat_frame/1', loadName: '3dprinted_2ml_tuberack_heat_frame', slotName: '7', vector: { x: 0.1, y: -0.2, z: -1 } };
	it('accepts a well-formed offset inside the 10 mm limit', () => {
		expect(checkLpcOffset(good)).toBeNull();
	});
	it('refuses a bad URI, slot, vector or an offset that is not "slightly off"', () => {
		expect(checkLpcOffset({ ...good, definitionUri: 'heat_frame' })).toMatch(/namespace\/loadName\/version/);
		expect(checkLpcOffset({ ...good, slotName: '13' })).toMatch(/slot 1–11/);
		expect(checkLpcOffset({ ...good, vector: { x: 'a', y: 0, z: 0 } })).toMatch(/numbers/);
		expect(checkLpcOffset({ ...good, vector: { x: 0, y: 0, z: -12 } })).toBeTruthy();
	});
});
