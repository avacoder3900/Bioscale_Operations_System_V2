/**
 * Guards on the numbers that get commanded at a real pipette.
 *
 * These exist because the 2026-08-21 reconciliation of feat/tip-calibrator-teach
 * with master had to choose, hunk by hunk, between two divergent implementations
 * of this path. The choice was: keep master's offset policy, keep THIS branch's
 * guards. Nothing enforced that second half, so it is enforced here.
 *
 * Every case below is a failure mode that actually reached a robot or was one
 * merge resolution away from doing so:
 *
 *   • a stored 0 read as a taught coordinate  -> tip driven to the deck corner
 *   • a null z_cal coerced by Number() to 0   -> probe depth straight through the deck
 *   • tip type inferred from the mount        -> 6.309 mm probe-depth error
 *
 * Pure functions only — no DB, no robot. What this file CANNOT tell you is
 * whether the pipette lands where it should; that still needs the fixture on
 * the wire.
 */
import { describe, it, expect } from 'vitest';
import {
	CAL_Z_LIMITS,
	DEFAULT_CALIBRATOR_XY,
	TIP_PROFILE,
	Z_CAL_FOR_PROCESS,
	applyCalibratorOverride,
	asTipProfile,
	finite,
	plausibleZ,
	taughtXY
} from './tip-calibrator';

describe('taughtXY — a stored 0 is not a taught coordinate', () => {
	it('accepts real non-zero coordinates, including negatives', () => {
		expect(taughtXY(125.181)).toBe(125.181);
		expect(taughtXY(173.247)).toBe(173.247);
		expect(taughtXY(-12.5)).toBe(-12.5);
		expect(taughtXY('125.181')).toBe(125.181);
	});

	it('rejects 0 — the fixture schema defaults x/y to it, so it means NEVER TAUGHT', () => {
		// This is the whole point of the function: finite(0) === 0 would have passed
		// a half-written fixture straight through as cal_x/cal_y.
		expect(taughtXY(0)).toBeUndefined();
		expect(taughtXY(-0)).toBeUndefined();
		expect(taughtXY('0')).toBeUndefined();
	});

	it('rejects junk, and rejects null rather than letting Number(null) become 0', () => {
		expect(taughtXY(null)).toBeUndefined();
		expect(taughtXY(undefined)).toBeUndefined();
		expect(taughtXY('')).toBeUndefined(); // Number('') === 0
		expect(taughtXY('abc')).toBeUndefined();
		expect(taughtXY(NaN)).toBeUndefined();
		expect(taughtXY(Infinity)).toBeUndefined();
	});

	it('falls back to the .py calibrator point, which is itself non-zero', () => {
		// If the default were ever zeroed the guard would be pointless.
		expect(taughtXY(DEFAULT_CALIBRATOR_XY.x)).toBe(DEFAULT_CALIBRATOR_XY.x);
		expect(taughtXY(DEFAULT_CALIBRATOR_XY.y)).toBe(DEFAULT_CALIBRATOR_XY.y);
	});
});

describe('plausibleZ — the touch-off depth envelope', () => {
	it('accepts both real probe depths and the window edges', () => {
		expect(plausibleZ(34.491)).toBe(34.491); // wax / p20
		expect(plausibleZ(40.8)).toBe(40.8); // reagent / p300
		expect(plausibleZ(CAL_Z_LIMITS.min)).toBe(CAL_Z_LIMITS.min);
		expect(plausibleZ(CAL_Z_LIMITS.max)).toBe(CAL_Z_LIMITS.max);
	});

	it('rejects below the floor — the crash direction', () => {
		expect(plausibleZ(0)).toBeUndefined();
		expect(plausibleZ(-1)).toBeUndefined();
		expect(plausibleZ(CAL_Z_LIMITS.min - 0.001)).toBeUndefined();
	});

	it('rejects above the ceiling — the no-reading direction', () => {
		expect(plausibleZ(500)).toBeUndefined();
		expect(plausibleZ(CAL_Z_LIMITS.max + 0.001)).toBeUndefined();
	});

	it('rejects null instead of coercing it to a probe depth of 0', () => {
		// Number(null) === 0, which a bare finite() read accepted. That is a probe
		// depth of zero — straight through the deck.
		expect(plausibleZ(null)).toBeUndefined();
		expect(plausibleZ(undefined)).toBeUndefined();
		expect(plausibleZ('')).toBeUndefined();
		expect(plausibleZ(NaN)).toBeUndefined();
	});

	it('rejects rather than clamps, so nothing is silently moved', () => {
		// A clamp would return CAL_Z_LIMITS.max here. It must not.
		expect(plausibleZ(9999)).not.toBe(CAL_Z_LIMITS.max);
		expect(plausibleZ(9999)).toBeUndefined();
		expect(plausibleZ(-9999)).not.toBe(CAL_Z_LIMITS.min);
		expect(plausibleZ(-9999)).toBeUndefined();
	});
});

describe('finite — the laxer read the guards deliberately replaced', () => {
	it('accepts exactly the values that made the guards necessary', () => {
		// Kept as a regression witness: if these ever start returning undefined,
		// finite() has been tightened and the guards above are doing less than
		// their comments claim.
		expect(finite(0)).toBe(0);
		expect(finite(null)).toBe(0);
		expect(finite(-1)).toBe(-1);
		expect(finite(500)).toBe(500);
	});
});

describe('tip profile — chosen, never inferred from the mount', () => {
	it('maps each profile to its own rack, z_cal key and pipette', () => {
		expect(TIP_PROFILE.wax.loadName).toBe('cosmasanddamian_96_tiprack_20ul');
		expect(TIP_PROFILE.wax.zCalKey).toBe('zCalWax');
		expect(TIP_PROFILE.wax.defaultZ).toBe(34.491);
		expect(TIP_PROFILE.wax.pipette).toBe('p20');

		expect(TIP_PROFILE.reagent.loadName).toBe('cosmas_and_damian_biotix_96_200ul_tiprack');
		expect(TIP_PROFILE.reagent.zCalKey).toBe('zCalReagent');
		expect(TIP_PROFILE.reagent.defaultZ).toBe(40.8);
		expect(TIP_PROFILE.reagent.pipette).toBe('p300');
	});

	it('keeps the two probe depths 6.309 mm apart — the cost of guessing wrong', () => {
		const gap = TIP_PROFILE.reagent.defaultZ - TIP_PROFILE.wax.defaultZ;
		expect(Number(gap.toFixed(3))).toBe(6.309);
	});

	it('asTipProfile fails CLOSED — a mount name is not a tip profile', () => {
		expect(asTipProfile('wax')).toBe('wax');
		expect(asTipProfile('reagent')).toBe('reagent');
		// The exact inputs a mount-inferring caller would send.
		expect(asTipProfile('left')).toBeUndefined();
		expect(asTipProfile('right')).toBeUndefined();
		expect(asTipProfile('')).toBeUndefined();
		expect(asTipProfile(null)).toBeUndefined();
		expect(asTipProfile(undefined)).toBeUndefined();
		expect(asTipProfile('WAX')).toBeUndefined();
	});

	it('Z_CAL_FOR_PROCESS agrees with TIP_PROFILE on both processes', () => {
		// Two tables, one truth. They are read by different callers (the RTP builder
		// vs the probe endpoint), so a drift between them is a silent wrong depth.
		expect(Z_CAL_FOR_PROCESS['wax-filling'].zCalKey).toBe(TIP_PROFILE.wax.zCalKey);
		expect(Z_CAL_FOR_PROCESS['wax-filling'].defaultZ).toBe(TIP_PROFILE.wax.defaultZ);
		expect(Z_CAL_FOR_PROCESS['reagent-filling'].zCalKey).toBe(TIP_PROFILE.reagent.zCalKey);
		expect(Z_CAL_FOR_PROCESS['reagent-filling'].defaultZ).toBe(TIP_PROFILE.reagent.defaultZ);
	});

	it('every default probe depth is itself inside the envelope', () => {
		expect(plausibleZ(TIP_PROFILE.wax.defaultZ)).toBe(TIP_PROFILE.wax.defaultZ);
		expect(plausibleZ(TIP_PROFILE.reagent.defaultZ)).toBe(TIP_PROFILE.reagent.defaultZ);
	});
});

describe('applyCalibratorOverride — the jogged point wins, axis by axis', () => {
	const base = { x: 125.181, y: 173.247, z: 34.491 };

	it('reports not-overridden and returns the base when nothing is sent', () => {
		expect(applyCalibratorOverride(base, null)).toEqual({ point: base, overridden: false });
		expect(applyCalibratorOverride(base, undefined)).toEqual({ point: base, overridden: false });
		expect(applyCalibratorOverride(base, {})).toEqual({ point: base, overridden: false });
	});

	it('overrides only the axes actually supplied', () => {
		const { point, overridden } = applyCalibratorOverride(base, { x: 130 });
		expect(overridden).toBe(true);
		expect(point).toEqual({ x: 130, y: base.y, z: base.z });
	});

	it('lets an operator jog an axis to 0 — this is a live reading, not a stored default', () => {
		// Deliberately different from taughtXY: there, 0 means "never written".
		// Here the operator is sending where the gantry actually is right now.
		const { point, overridden } = applyCalibratorOverride(base, { x: 0 });
		expect(overridden).toBe(true);
		expect(point.x).toBe(0);
	});

	it('ignores unusable axes rather than writing NaN into a commanded point', () => {
		const { point, overridden } = applyCalibratorOverride(base, { x: 'abc', y: undefined, z: 36 });
		expect(overridden).toBe(true);
		expect(point).toEqual({ x: base.x, y: base.y, z: 36 });
		expect(Number.isFinite(point.x)).toBe(true);
	});
});
