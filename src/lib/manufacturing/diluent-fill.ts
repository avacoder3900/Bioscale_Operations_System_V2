/**
 * Sample diluent fill — the numbers BIMS and the robot protocol agree on
 * (DILUENT-FILL-1). Mirrors the constants at the top of
 * protocols/Sample_Diluent_Fill_v2.py; change them together.
 *
 * Lives outside $lib/server so the wizard can show the operator the minimum
 * source volume while they type, with the same arithmetic the protocol's
 * pre-flight check runs on the robot.
 */

export type DiluentPipette = 'p1000' | 'p300';

export const DILUENT_SOURCE_RACK = 'opentrons_15_tuberack_falcon_15ml_conical';
export const DILUENT_SOURCE_SLOT = 10;
/** Source 1, 2, 3 → these wells of the 15-tube rack. */
export const DILUENT_SOURCE_WELLS = ['A1', 'A2', 'A3'] as const;

export const DILUENT_TIPRACK_SLOT = 11;

export const DILUENT_DEST_RACK = '3dprinted_2ml_tuberack_heat_frame';
/** Source 1, 2, 3 → the heat-frame rack in these slots (back, middle, front row). */
export const DILUENT_DEST_SLOTS = [7, 4, 1] as const;
/** The heat-frame definition exposes every other hole of the 80-hole rack. */
export const DILUENT_TUBES_PER_RACK = 40;

export const DILUENT_DEFAULT_VOLUME_UL = 104.5;
export const DILUENT_MIN_VOLUME_UL = 8;
export const DILUENT_MAX_VOLUME_UL = 300;

export interface DiluentPipetteSpec {
	label: string;
	name: string;
	mount: 'left' | 'right';
	tiprack: string;
	tiprackLabel: string;
	tipCapacityUl: number;
	maxTubesPerTrip: number;
	carryBackUl: number;
	/** How far below the source rim the tip end may go (PLACEHOLDER — verify by jogging). */
	maxDescentMm: number;
}

export const DILUENT_PIPETTES: Record<DiluentPipette, DiluentPipetteSpec> = {
	p1000: {
		label: 'P1000 single (right)',
		name: 'p1000_single_gen2',
		mount: 'right',
		tiprack: 'opentrons_96_tiprack_1000ul',
		tiprackLabel: 'Opentrons 1000 µL tips',
		tipCapacityUl: 1000,
		maxTubesPerTrip: 8,
		carryBackUl: 20,
		maxDescentMm: 100
	},
	p300: {
		label: 'P300 single (left)',
		name: 'p300_single_gen2',
		mount: 'left',
		tiprack: 'cosmas_and_damian_biotix_96_200ul_tiprack',
		tiprackLabel: 'Biotix 200 µL tips',
		tipCapacityUl: 200,
		maxTubesPerTrip: 1,
		carryBackUl: 10,
		maxDescentMm: 72
	}
};

export const isDiluentPipette = (v: unknown): v is DiluentPipette => v === 'p1000' || v === 'p300';

// ── 15 mL Falcon conical geometry (PLACEHOLDERS until measured; same values as the .py) ──
const TUBE_DEPTH_MM = 117.5;
const CONE_HEIGHT_MM = 21.5;
const CONE_VOLUME_UL = 1500;
const BODY_UL_PER_MM = 169;
const ASPIRATE_COVER_MM = 3;

/** Liquid surface height above the inside bottom for a volume. */
export function diluentLevelMm(volumeUl: number): number {
	if (volumeUl <= 0) return 0;
	if (volumeUl <= CONE_VOLUME_UL) return CONE_HEIGHT_MM * Math.cbrt(volumeUl / CONE_VOLUME_UL);
	return CONE_HEIGHT_MM + (volumeUl - CONE_VOLUME_UL) / BODY_UL_PER_MM;
}

/** Inverse of diluentLevelMm. */
export function diluentVolumeAtLevelUl(levelMm: number): number {
	if (levelMm <= 0) return 0;
	if (levelMm <= CONE_HEIGHT_MM) return CONE_VOLUME_UL * Math.pow(levelMm / CONE_HEIGHT_MM, 3);
	return CONE_VOLUME_UL + (levelMm - CONE_HEIGHT_MM) * BODY_UL_PER_MM;
}

/** Diluent the tip can never reach at the bottom of the source tube, for this pipette. */
export function diluentFloorUl(pipette: DiluentPipette): number {
	const spec = DILUENT_PIPETTES[pipette];
	return diluentVolumeAtLevelUl(TUBE_DEPTH_MM - spec.maxDescentMm + ASPIRATE_COVER_MM);
}

/** Tubes one aspirate serves: what was asked, within the pipette and its tip. */
export function diluentTubesPerTrip(pipette: DiluentPipette, requested: number, volumeUl: number): number {
	const spec = DILUENT_PIPETTES[pipette];
	const fits = Math.floor((spec.tipCapacityUl - spec.carryBackUl) / Math.max(volumeUl, 1));
	return Math.max(1, Math.min(Math.floor(requested) || 1, spec.maxTubesPerTrip, fits));
}

/**
 * The least a source tube must hold for `tubes` tubes — what the protocol's
 * pre-flight requires. Rounded UP to 10 µL (0.01 mL) in both places, so the
 * number the operator reads here is exactly the one the robot checks against.
 */
export function diluentMinSourceUl(pipette: DiluentPipette, tubes: number, volumeUl: number): number {
	if (tubes <= 0) return 0;
	const exact = tubes * volumeUl + DILUENT_PIPETTES[pipette].carryBackUl + diluentFloorUl(pipette);
	return Math.ceil(exact / 10 - 1e-9) * 10;
}

/** µL → mL for display, rounded UP to 0.01 mL (a multiple of 10 µL is shown exactly). */
export const ulToMlUp = (ul: number): number => Math.ceil(ul / 10 - 1e-9) / 100;

export interface DiluentSourceRecord {
	well: string;
	reagentLotId?: string | null;
	reagentLotBarcode?: string | null;
	templateName?: string | null;
	tubesPlanned: number;
	loadedMl: number;
	tubesFilled?: number | null;
}

export interface DiluentRunLike {
	pipette: DiluentPipette;
	diluentVolumeUl: number;
	tubesPerTrip: number;
	sources: DiluentSourceRecord[];
}

/** The run-time parameters the record dictates (the posted form never decides counts or volumes). */
export function diluentRunTimeParameters(run: DiluentRunLike): Record<string, number | string> {
	const out: Record<string, number | string> = {
		pipette: run.pipette,
		diluent_vol: run.diluentVolumeUl,
		tubes_per_trip: diluentTubesPerTrip(run.pipette, run.tubesPerTrip, run.diluentVolumeUl)
	};
	DILUENT_SOURCE_WELLS.forEach((well, i) => {
		const s = run.sources.find((x) => x.well === well);
		out[`src_${i + 1}_tubes`] = s?.tubesPlanned ?? 0;
		out[`src_${i + 1}_ml`] = s?.loadedMl ?? 0;
	});
	return out;
}

export const diluentTubesTotal = (sources: DiluentSourceRecord[]): number =>
	sources.reduce((n, s) => n + Math.max(0, Math.floor(s.tubesPlanned || 0)), 0);

/** Rough wall-clock estimate: ~25 s per aspirate trip, ~7 s per tube, a minute of homing and tips. */
export function diluentEstimateSeconds(run: DiluentRunLike): number {
	const tpt = diluentTubesPerTrip(run.pipette, run.tubesPerTrip, run.diluentVolumeUl);
	let trips = 0;
	let tubes = 0;
	for (const s of run.sources) {
		const n = Math.max(0, Math.floor(s.tubesPlanned || 0));
		if (!n) continue;
		tubes += n;
		trips += Math.ceil(n / tpt);
	}
	return 60 + trips * 25 + tubes * 7;
}

/** Validation the wizard and the server both apply to a setup. Returns messages; empty = valid. */
export function validateDiluentSetup(run: DiluentRunLike): string[] {
	const errors: string[] = [];
	if (!isDiluentPipette(run.pipette)) errors.push('Pick a pipette.');
	if (!(run.diluentVolumeUl >= DILUENT_MIN_VOLUME_UL && run.diluentVolumeUl <= DILUENT_MAX_VOLUME_UL)) {
		errors.push(`Volume per tube must be between ${DILUENT_MIN_VOLUME_UL} and ${DILUENT_MAX_VOLUME_UL} µL.`);
	}
	if (diluentTubesTotal(run.sources) < 1) errors.push('Plan at least one tube.');
	for (const s of run.sources) {
		const n = Math.floor(s.tubesPlanned || 0);
		if (n < 0 || n > DILUENT_TUBES_PER_RACK) errors.push(`Source ${s.well}: tubes must be 0–${DILUENT_TUBES_PER_RACK}.`);
		if (n === 0) continue;
		if (!s.reagentLotId) errors.push(`Source ${s.well}: pick the reagent lot in the tube.`);
		if (!(s.loadedMl > 0)) errors.push(`Source ${s.well}: enter the volume loaded (mL).`);
		else if (isDiluentPipette(run.pipette)) {
			const minUl = diluentMinSourceUl(run.pipette, n, run.diluentVolumeUl);
			if (s.loadedMl * 1000 + 1e-6 < minUl) {
				errors.push(`Source ${s.well}: ${s.loadedMl} mL loaded but ${n} tubes need at least ${ulToMlUp(minUl)} mL.`);
			}
		}
	}
	return errors;
}
