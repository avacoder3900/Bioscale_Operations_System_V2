/**
 * Validation cycles (2026-09-10, per Jacob; instruments re-cut 2026-10-13).
 *
 * A unit's validations only count for the CURRENT cycle. Entering servicing
 * starts a new cycle: the counter drops to 0/N, the rollups on the unit record
 * are cleared, and every instrument has to pass again before the unit can be
 * released.
 *
 * The instruments (screen pipeline, 2026-10-13):
 *   screen        — the one-button SCREEN: self-test suite + laser blast + the
 *                   real assay motion ×3 with the stage check (firmware v102)
 *   magnetometer  — the magnet test (fixed-point read today, peaks sweep next)
 *   thermocouple  — the heat-cart hold read by the thermocouple tool
 *   assay_run     — a GROUP of real cartridges run on the unit (replaces the
 *                   optical confirmation / degradation / blank gate)
 * 'spectrophotometer' is LEGACY: rollups written before 2026-10-13 are kept on
 * the unit record and still readable through cycleSummary().legacy, but it is
 * no longer an instrument and earns no credit.
 *
 * `validationResetAt` marks the cycle start. Evidence recorded before it
 * (validation_sessions, cartridge groups) is kept as history but earns no
 * credit. Readers use cycleSummary(); writers that move a unit into servicing
 * call beginValidationCycle() (or spread validationCycleResetFields() into a
 * native $set when they must bypass Mongoose).
 */
import { Spu } from '$lib/server/db';

export const VALIDATION_INSTRUMENTS = ['screen', 'magnetometer', 'thermocouple', 'assay_run'] as const;
export type ValidationInstrument = (typeof VALIDATION_INSTRUMENTS)[number];
export const LEGACY_VALIDATION_INSTRUMENTS = ['spectrophotometer'] as const;
export type CycleStatus = 'pending' | 'passed' | 'failed' | 'overridden';

export const INSTRUMENT_LABELS: Record<ValidationInstrument, string> = {
	screen: 'Screen',
	magnetometer: 'Magnetometer',
	thermocouple: 'Thermocouple',
	assay_run: 'Assay Run'
};

export function isPassed(status: string | null | undefined): boolean {
	return status === 'passed' || status === 'overridden';
}

/** True when `at` falls inside the current cycle. No reset ⇒ everything counts. */
export function inCurrentCycle(
	at: Date | string | null | undefined,
	resetAt: Date | string | null | undefined
): boolean {
	if (!resetAt) return true;
	if (!at) return false;
	return new Date(at).getTime() >= new Date(resetAt).getTime();
}

/** One instrument's status for the current cycle — a pre-cycle result reads as pending. */
export function cycleStatus(
	rollup: { status?: string; completedAt?: Date | string | null } | null | undefined,
	resetAt: Date | string | null | undefined
): CycleStatus {
	const status = (rollup?.status ?? 'pending') as CycleStatus;
	if (status === 'pending') return 'pending';
	return inCurrentCycle(rollup?.completedAt, resetAt) ? status : 'pending';
}

export interface CycleSummary {
	statuses: Record<ValidationInstrument, CycleStatus>;
	passed: number;
	total: number;
	overall: 'pending' | 'passed' | 'failed';
	/** The retired optics rollup, for history displays only. Never counted. */
	legacy: { spectrophotometer: CycleStatus };
}

type RollupShape = { status?: string; completedAt?: Date | string | null };

export function cycleSummary(spu: {
	validation?: Partial<Record<ValidationInstrument | 'spectrophotometer', RollupShape>> | null;
	validationResetAt?: Date | string | null;
}): CycleSummary {
	const v = spu.validation ?? {};
	const resetAt = spu.validationResetAt ?? null;
	const statuses = {
		screen: cycleStatus(v.screen, resetAt),
		magnetometer: cycleStatus(v.magnetometer, resetAt),
		thermocouple: cycleStatus(v.thermocouple, resetAt),
		assay_run: cycleStatus(v.assay_run, resetAt)
	};
	const all = Object.values(statuses);
	const passed = all.filter(isPassed).length;
	const overall = all.every(isPassed)
		? 'passed'
		: all.some((s) => s === 'failed')
			? 'failed'
			: 'pending';
	return {
		statuses,
		passed,
		total: VALIDATION_INSTRUMENTS.length,
		overall,
		legacy: { spectrophotometer: cycleStatus(v.spectrophotometer, resetAt) }
	};
}

/** The $set that starts a new cycle. Exposed for writers that bypass Mongoose. */
export function validationCycleResetFields(at: Date): Record<string, unknown> {
	return {
		validationResetAt: at,
		'validation.status': 'pending',
		'validation.screen': { status: 'pending' },
		'validation.magnetometer': { status: 'pending' },
		'validation.thermocouple': { status: 'pending' },
		'validation.assay_run': { status: 'pending' },
		// Legacy slot: cleared too so a stale optics pass never reads as current.
		'validation.spectrophotometer': { status: 'pending' }
	};
}

/** Start a new validation cycle on a unit (called when it enters servicing). */
export async function beginValidationCycle(spuId: string, at: Date = new Date()): Promise<void> {
	await Spu.updateOne({ _id: spuId }, { $set: validationCycleResetFields(at) });
}
