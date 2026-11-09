import { describe, expect, it } from 'vitest';
import { GATE_VOLUME_DEFAULTS, gateVolumesFrom, gateVolumesText, parseGateVolumes, rowTotalUl, tripsPerRow } from './gate-volumes';

describe('gate volumes', () => {
	it('defaults to the carriage line: 1.8 / 2.2 / 2.2 / 2.2, a row of 8.4', () => {
		expect(gateVolumesText(GATE_VOLUME_DEFAULTS)).toBe('1.8 / 2.2 / 2.2 / 2.2');
		expect(rowTotalUl(GATE_VOLUME_DEFAULTS)).toBe(8.4);
	});

	it('reads a settings document saved before the volumes existed as the defaults', () => {
		expect(gateVolumesFrom(undefined)).toEqual(GATE_VOLUME_DEFAULTS);
		expect(gateVolumesFrom({})).toEqual(GATE_VOLUME_DEFAULTS);
	});

	it('reads stored volumes, and the default for a gate that is missing or out of range', () => {
		expect(gateVolumesFrom({ g1: 1.6, g2: 1.6, g3: 0, g4: 'x' })).toEqual({ g1: 1.6, g2: 1.6, g3: 2.2, g4: 2.2 });
	});

	it('parses the four Setup boxes to 0.01 µL', () => {
		expect(parseGateVolumes({ g1: '1.8', g2: ' 2.2 ', g3: 2.204, g4: '2' })).toEqual({ g1: 1.8, g2: 2.2, g3: 2.2, g4: 2 });
	});

	it('refuses a box that is empty, not a number or outside the protocol range, naming the gate', () => {
		expect(() => parseGateVolumes({ g1: '1.8', g2: '', g3: '2.2', g4: '2.2' })).toThrow('Gate 2 volume must be a number.');
		expect(() => parseGateVolumes({ g1: 'abc', g2: '2', g3: '2', g4: '2' })).toThrow('Gate 1 volume must be a number.');
		expect(() => parseGateVolumes({ g1: '1.8', g2: '2.2', g3: '0', g4: '2.2' })).toThrow('Gate 3 volume must be 0.1–20 µL.');
		expect(() => parseGateVolumes({ g1: '1.8', g2: '2.2', g3: '2.2', g4: '21' })).toThrow('Gate 4 volume must be 0.1–20 µL.');
	});
});

describe('tripsPerRow', () => {
	it('the carriage volumes fit one aspiration over the 11.5 µL remainder', () => {
		expect(tripsPerRow(GATE_VOLUME_DEFAULTS, 11.5)).toBe(1);
	});

	it('a row over what one aspiration holds takes a second trip', () => {
		expect(tripsPerRow({ g1: 2.2, g2: 2.2, g3: 2.2, g4: 2.2 }, 11.5)).toBe(2);
	});

	it('follows the protocol: gates 4 to 1, a new trip when the next hole does not fit', () => {
		// 8.5 usable: gate 4 (5) + gate 3 (3) = 8, gate 2 (3) starts trip 2, gate 1 (3) fits it.
		expect(tripsPerRow({ g1: 3, g2: 3, g3: 3, g4: 5 }, 11.5)).toBe(2);
		expect(tripsPerRow({ g1: 5, g2: 5, g3: 5, g4: 5 }, 11.5)).toBe(4);
	});
});
