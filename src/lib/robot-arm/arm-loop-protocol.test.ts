import { describe, expect, it } from 'vitest';
import { isArmPauseMessage, isParkedFor, parseArmPause } from './arm-loop-protocol';

describe('arm-loop-protocol pause messages', () => {
	it('parses the three pause kinds with their cart index', () => {
		expect(parseArmPause('ARM PARKED 1')).toEqual({ kind: 'PARKED', cart: 1 });
		expect(parseArmPause('ARM AT_SCAN 12')).toEqual({ kind: 'AT_SCAN', cart: 12 });
		expect(parseArmPause('ARM NO_INSTRUCTION 3')).toEqual({ kind: 'NO_INSTRUCTION', cart: 3 });
		expect(parseArmPause('  ARM PARKED 2 — tip in the wax')).toEqual({ kind: 'PARKED', cart: 2 });
	});

	it('rejects pauses the arm line does not own', () => {
		expect(parseArmPause('TIP TRACKER: tiprack exhausted')).toBeNull();
		expect(parseArmPause('NO TIP DETECTED (attempt 1)')).toBeNull();
		expect(parseArmPause('ARM PARKED')).toBeNull();
		expect(parseArmPause(null)).toBeNull();
		expect(parseArmPause(undefined)).toBeNull();
	});

	it('isArmPauseMessage covers every ARM pause, parsed or not', () => {
		expect(isArmPauseMessage('ARM PARKED 1')).toBe(true);
		expect(isArmPauseMessage('ARM something new')).toBe(true);
		expect(isArmPauseMessage('Confirm the deck is loaded')).toBe(false);
	});

	it('the arm moves only when parked for the expected cart', () => {
		expect(isParkedFor({ kind: 'PARKED', cart: 2 }, 2)).toBe(true);
		expect(isParkedFor({ kind: 'PARKED', cart: 3 }, 2)).toBe(false);
		expect(isParkedFor({ kind: 'AT_SCAN', cart: 2 }, 2)).toBe(false);
		expect(isParkedFor({ kind: 'NO_INSTRUCTION', cart: 2 }, 2)).toBe(false);
		expect(isParkedFor(null, 2)).toBe(false);
	});
});

describe('armMayMove — a park resumed from outside the loop (2026-10-30)', async () => {
	const { armMayMove, atScanFor } = await import('./arm-loop-protocol');
	const parked = (cart: number, paused: boolean) => ({ kind: 'PARKED' as const, cart, paused });
	const noInstr = (cart: number) => ({ kind: 'NO_INSTRUCTION' as const, cart, paused: true });
	it('NO_INSTRUCTION right after the park counts as parked while nothing was sent', () => {
		expect(armMayMove('paused', noInstr(2), { parked: 2 }, { prev: parked(2, false), uninstructed: true })).toBe(true);
		expect(armMayMove('paused', noInstr(2), { parked: 2 }, { prev: parked(2, false), uninstructed: false })).toBe(false);
		expect(armMayMove('paused', noInstr(2), { parked: 2 }, { prev: { kind: 'AT_SCAN', cart: 2, paused: false }, uninstructed: true })).toBe(false);
	});
	it('a resumed park still polling counts as parked only while nothing was sent', () => {
		expect(armMayMove('running', parked(2, false), { parked: 2 }, { uninstructed: true })).toBe(true);
		expect(armMayMove('running', parked(2, false), { parked: 2 }, { uninstructed: false })).toBe(false);
	});
	it('AT_SCAN resumed from outside is still at the scan position', () => {
		expect(atScanFor('paused', noInstr(1), { kind: 'AT_SCAN', cart: 1, paused: false }, 1)).toBe(true);
		expect(atScanFor('paused', noInstr(1), parked(1, false), 1)).toBe(false);
	});
});
