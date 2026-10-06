// Field magnitude for magnetometer validation.
//
// The device reports T/X/Y/Z per channel per well and BIMS has always stored all
// of it — but |B| = √(X² + Y² + Z²) was only ever computed in the browser, on the
// session detail page, and thrown away. Nothing downstream (the list view, the
// CSV export, the MCP tab) could show a field value, because no field value was
// ever persisted.
//
// This module is the single canonical derivation. Both ingest writers
// (/api/validation/magnetometer/poll and /validation/magnetometer/run) use it so
// the two paths cannot drift apart.
//
// Unit: GAUSS. The stored X/Y/Z are raw magnetometer counts as the firmware
// reports them, which the rest of the app already labels gauss (formatGauss,
// gaussMin/gaussMax). No conversion is applied here — magnitude carries exactly
// the unit its components carry.

export const FIELD_UNIT = 'gauss' as const;

export type MagChannel = 'A' | 'B' | 'C';

export const MAG_CHANNELS: readonly MagChannel[] = ['A', 'B', 'C'];

/** The component keys this module reads. Both ingest paths' well shapes satisfy
 *  this structurally; extra keys (chX_T, well, error) are irrelevant here. */
export interface MagWellComponents {
	chA_X?: number | null; chA_Y?: number | null; chA_Z?: number | null;
	chB_X?: number | null; chB_Y?: number | null; chB_Z?: number | null;
	chC_X?: number | null; chC_Y?: number | null; chC_Z?: number | null;
}

/** The per-well keys this module ADDS, inside each magResults element. */
export interface MagWellMagnitudes {
	chA_mag: number | null;
	chB_mag: number | null;
	chC_mag: number | null;
}

/** A well as it is stored in magResults once magnitudes have been folded in. */
export type MagWellResult = MagWellComponents & MagWellMagnitudes;

/** Session-level rollup, stored as a TOP-LEVEL field on the validation session
 *  (and mirrored onto spus.validation.magnetometer). Both schemas must declare
 *  it — Mongoose strict mode silently drops undeclared top-level fields. */
export interface FieldSummary {
	unit: typeof FIELD_UNIT;
	wellCount: number;
	minMag: number | null;
	maxMag: number | null;
	meanMag: number | null;
}

/** A component is usable only if it is a real finite number. null, undefined,
 *  NaN and Infinity are all "no reading" — never silently 0. */
function component(well: MagWellComponents, ch: MagChannel, axis: 'X' | 'Y' | 'Z'): number | null {
	const v = (well as Record<string, unknown>)[`ch${ch}_${axis}`];
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * |B| = √(x² + y² + z²), or null if ANY component is missing.
 *
 * A partial reading is not a small field, it is an unknown one — returning 0 (or
 * NaN) there would put a fake value on the DHR. Missing beats wrong.
 */
export function channelMagnitude(
	x: number | null | undefined,
	y: number | null | undefined,
	z: number | null | undefined
): number | null {
	if (typeof x !== 'number' || !Number.isFinite(x)) return null;
	if (typeof y !== 'number' || !Number.isFinite(y)) return null;
	if (typeof z !== 'number' || !Number.isFinite(z)) return null;

	const mag = Math.sqrt(x * x + y * y + z * z);
	return Number.isFinite(mag) ? mag : null;
}

/** Magnitude of one channel of one well. */
export function wellChannelMagnitude(well: MagWellComponents, ch: MagChannel): number | null {
	return channelMagnitude(component(well, ch, 'X'), component(well, ch, 'Y'), component(well, ch, 'Z'));
}

/**
 * Return the wells with chA_mag/chB_mag/chC_mag added. Non-mutating: callers get
 * new objects and keep every key they already had (well, error, chX_T, …).
 */
export function withFieldMagnitudes<T extends MagWellComponents>(wells: T[]): Array<T & MagWellMagnitudes> {
	return wells.map((well) => ({
		...well,
		chA_mag: wellChannelMagnitude(well, 'A'),
		chB_mag: wellChannelMagnitude(well, 'B'),
		chC_mag: wellChannelMagnitude(well, 'C')
	}));
}

/**
 * Session-level summary across every usable per-channel magnitude.
 *
 * `wellCount` is how many wells the session has, not how many were usable — a
 * 5-well run where nothing read back is still a 5-well run, with all three
 * numeric fields null.
 */
export function summarizeField(wells: MagWellComponents[] | null | undefined): FieldSummary {
	const list = Array.isArray(wells) ? wells : [];
	const mags: number[] = [];

	for (const well of list) {
		if (!well || typeof well !== 'object') continue;
		for (const ch of MAG_CHANNELS) {
			const mag = wellChannelMagnitude(well, ch);
			if (mag !== null) mags.push(mag);
		}
	}

	if (mags.length === 0) {
		return { unit: FIELD_UNIT, wellCount: list.length, minMag: null, maxMag: null, meanMag: null };
	}

	let min = mags[0];
	let max = mags[0];
	let total = 0;
	for (const mag of mags) {
		if (mag < min) min = mag;
		if (mag > max) max = mag;
		total += mag;
	}

	return {
		unit: FIELD_UNIT,
		wellCount: list.length,
		minMag: min,
		maxMag: max,
		meanMag: total / mags.length
	};
}
