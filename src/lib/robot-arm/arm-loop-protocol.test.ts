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

describe('ARM PROBING — a status marker only; the first grab waits for ARM CALIBRATED (2026-11-06)', async () => {
	const { armMayMove, parseArmComment } = await import('./arm-loop-protocol');
	it('parses the announcements, PROBING and CALIBRATED with cart 0', () => {
		expect(parseArmComment('ARM PROBING')).toEqual({ kind: 'PROBING', cart: 0 });
		expect(parseArmComment('ARM CALIBRATED')).toEqual({ kind: 'CALIBRATED', cart: 0 });
		expect(parseArmComment('ARM CLEAR 3')).toEqual({ kind: 'CLEAR', cart: 3 });
		expect(parseArmComment('ARM PARKED 1')).toBeNull();
		expect(parseArmComment('Tip calibration OK')).toBeNull();
	});
	it('never lets the arm move at PROBING — the probe is where a missing tip is found', () => {
		const probing = { kind: 'PROBING' as const, cart: 0, paused: false };
		expect(armMayMove('running', probing, { parked: 1, orCalibrated: true })).toBe(false);
		expect(armMayMove('paused', probing, { parked: 1, orCalibrated: true })).toBe(false);
		expect(armMayMove('running', probing, { parked: 2, orClear: 1 })).toBe(false);
		// The NO TIP DETECTED pause carries no ARM note: the last marker stays PROBING and the run is paused — still no.
		expect(armMayMove('paused', { kind: 'PROBING' as const, cart: 0, paused: true }, { parked: 1, orCalibrated: true })).toBe(false);
	});
	it('lets the first grab start at CALIBRATED — announced only after a successful probe with a tip on', () => {
		const calibrated = { kind: 'CALIBRATED' as const, cart: 0, paused: false };
		expect(armMayMove('running', calibrated, { parked: 1, orCalibrated: true })).toBe(true);
		expect(armMayMove('paused', calibrated, { parked: 1, orCalibrated: true })).toBe(false);
		// Never a later cart's grab: CALIBRATED is a start-up marker only.
		expect(armMayMove('running', calibrated, { parked: 2, orClear: 1 })).toBe(false);
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

describe('ARM FILLED — the withdraw may start once the final row is filled (2026-11-05)', async () => {
	const { armMayMove, parseArmComment } = await import('./arm-loop-protocol');
	const filled = (cart: number) => ({ kind: 'FILLED' as const, cart, paused: false });
	it('parses the announcement with its cart; the older ARM CART comment is not it', () => {
		expect(parseArmComment('ARM FILLED 3')).toEqual({ kind: 'FILLED', cart: 3 });
		expect(parseArmComment('ARM CART 3 FILLED 0123456789')).toBeNull();
	});
	it('lets the withdraw of that cart start while the run is running, nothing else', () => {
		// withdraw(2): parked for 3, or running after CLEAR 2, or (new) after FILLED 2.
		const withdraw2 = { parked: 3, orClear: 2, orFilled: 2 };
		expect(armMayMove('running', filled(2), withdraw2)).toBe(true);
		expect(armMayMove('running', { kind: 'CLEAR', cart: 2, paused: false }, withdraw2)).toBe(true);
		expect(armMayMove('running', filled(1), withdraw2)).toBe(false); // the previous cart's
		expect(armMayMove('paused', filled(2), withdraw2)).toBe(false); // a paused run is on a pause marker
		// The fail animation and the next grab do not ask for it: they still wait for CLEAR / PARKED.
		expect(armMayMove('running', filled(2), { parked: 3, orClear: 2 })).toBe(false);
	});
});

describe('tornPauseRead', () => {
	it('is a running run whose log has a waitForResume in progress', async () => {
		const { tornPauseRead, armMayMove } = await import('./arm-loop-protocol');
		const parked2 = { commandType: 'waitForResume', status: 'running', params: { message: 'ARM PARKED 2' } };
		expect(tornPauseRead('running', [{ commandType: 'comment', status: 'succeeded' }, parked2])).toBe(true);
		// The same log with the status read after the pause began: consistent.
		expect(tornPauseRead('paused', [parked2])).toBe(false);
		// A resumed pause has succeeded; a running run after it is not torn.
		expect(tornPauseRead('running', [{ commandType: 'waitForResume', status: 'succeeded' }])).toBe(false);
		expect(tornPauseRead('running', [])).toBe(false);
		// Why it matters: the torn read is refused, the re-read one is allowed (the fail animation after a skip of cart 1).
		const want = { parked: 2, orClear: 1 };
		const marker = { kind: 'PARKED' as const, cart: 2, paused: true };
		expect(armMayMove('running', marker, want, { uninstructed: true })).toBe(false);
		expect(armMayMove('paused', marker, want, { uninstructed: true })).toBe(true);
	});
});
