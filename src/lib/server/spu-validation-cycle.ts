/**
 * Validation cycles (2026-09-10, per Jacob).
 *
 * A unit's three validations — magnetometer, thermocouple, optics — only count
 * for the CURRENT cycle. Entering servicing starts a new cycle: the counter
 * drops to 0/3, the rollups on the unit record are cleared, and every
 * instrument has to pass again before the unit can be released.
 *
 * `validationResetAt` marks the cycle start. Evidence recorded before it
 * (validation_sessions, optical cartridge runs) is kept as history but earns
 * no credit. Readers use cycleSummary(); writers that move a unit into
 * servicing call beginValidationCycle() (or spread validationCycleResetFields()
 * into a native $set when they must bypass Mongoose).
 */
import { Spu } from '$lib/server/db';

export const VALIDATION_INSTRUMENTS = ['magnetometer', 'thermocouple', 'spectrophotometer'] as const;
export type ValidationInstrument = (typeof VALIDATION_INSTRUMENTS)[number];
export type CycleStatus = 'pending' | 'passed' | 'failed' | 'overridden';

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
}

export function cycleSummary(spu: {
	validation?: Partial<
		Record<ValidationInstrument, { status?: string; completedAt?: Date | string | null }>
	> | null;
	validationResetAt?: Date | string | null;
}): CycleSummary {
	const v = spu.validation ?? {};
	const resetAt = spu.validationResetAt ?? null;
	const statuses = {
		magnetometer: cycleStatus(v.magnetometer, resetAt),
		thermocouple: cycleStatus(v.thermocouple, resetAt),
		spectrophotometer: cycleStatus(v.spectrophotometer, resetAt)
	};
	const all = Object.values(statuses);
	const passed = all.filter(isPassed).length;
	const overall = all.every(isPassed)
		? 'passed'
		: all.some((s) => s === 'failed')
			? 'failed'
			: 'pending';
	return { statuses, passed, total: VALIDATION_INSTRUMENTS.length, overall };
}

/** The $set that starts a new cycle. Exposed for writers that bypass Mongoose. */
export function validationCycleResetFields(at: Date): Record<string, unknown> {
	return {
		validationResetAt: at,
		'validation.status': 'pending',
		'validation.magnetometer': { status: 'pending' },
		'validation.thermocouple': { status: 'pending' },
		'validation.spectrophotometer': { status: 'pending' }
	};
}

/** Start a new validation cycle on a unit (called when it enters servicing). */
export async function beginValidationCycle(spuId: string, at: Date = new Date()): Promise<void> {
	await Spu.updateOne({ _id: spuId }, { $set: validationCycleResetFields(at) });
}
