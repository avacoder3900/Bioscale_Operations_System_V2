/**
 * The one positional bound the Studio must enforce for the robot's sake.
 *
 * 2026-10-26: three Studio edits on gen4deck_gen7cartridge_004 left 12 A-row
 * wax holes at y = -0.5. Opentrons' labware schema requires 0 <= x, y, and the
 * protocol upload bundles the whole library, so every start on B07 AND R04
 * failed with "could not be read as a labware definition" until the deck was
 * restored by script. Z already had a floor; X and Y did not.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({
	connectDB: async () => {},
	generateId: () => 'gen',
	LabwareDefinition: {},
	DeckCalibrationEdit: {},
	AuditLog: {}
}));
vi.mock('./resolve', () => ({ resolveLabwareDefinition: async () => ({ doc: {}, matchCount: 1, uri: 'x' }), isDeckLoadName: () => true }));

import { belowDeckFloor } from './apply-edit';

const deck = { definition: { dimensions: { zDimension: 12.7 } } };

describe('belowDeckFloor — refuse what the robot would refuse', () => {
	it('allows any non-negative position, including raised holes and the deck edge', () => {
		expect(belowDeckFloor({ x: 0, y: 0, z: 0 }, deck)).toBeNull();
		expect(belowDeckFloor({ x: 48.477, y: 0.5, z: 8.65 }, deck)).toBeNull();
		expect(belowDeckFloor({ x: 400, y: 300, z: 80 }, deck)).toBeNull();
	});
	it('refuses a negative X or Y and names the axis and the consequence', () => {
		expect(belowDeckFloor({ x: 48.028, y: -0.5, z: 9.65 }, deck)).toMatch(/^y -0\.50mm is below 0 .*rejects the whole labware definition/);
		expect(belowDeckFloor({ x: -0.01, y: 10, z: 5 }, deck)).toMatch(/^x -0\.01mm is below 0/);
	});
	it('still refuses Z below the deck floor', () => {
		expect(belowDeckFloor({ x: 10, y: 10, z: -0.1 }, deck)).toMatch(/below the 12\.7mm-tall deck's floor/);
	});
});
