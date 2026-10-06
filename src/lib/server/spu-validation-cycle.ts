/**
 * Validation cycles (2026-09-10, per Jacob).
 *
 * A unit's graded validations — magnetometer and thermocouple — only count
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
import type { AutoVerdict } from './validation-autograde';

/**
 * What gates release. Optical confirmation (`spectrophotometer`) was dropped
 * on 2026-10-06 (per Alejandro): it is an assay, not a device check, and is
 * banked until it is relevant again. Its rollup field stays on the Spu and the
 * optical-confirmation pages still exist — they are just not linked from the
 * validation section and no longer count toward release. To bring it back,
 * add 'spectrophotometer' here and its row back to VALIDATION_TESTS.
 */
export const VALIDATION_INSTRUMENTS = ['magnetometer', 'thermocouple'] as const;
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
		thermocouple: cycleStatus(v.thermocouple, resetAt)
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

/**
 * The tests the SPU Validation section offers, and where each one's
 * evidence actually lives (2026-09-17, per Alejandro).
 *
 * Only mag and thermo carry a pass/fail rollup on the unit. Blank cartridge,
 * sonic fingerprint and optical bench store no verdict (`passed: null`); bench
 * and blank are graded on read instead. This list answers "did a run happen
 * since the unit was sent to servicing, and did it look right" — NOT release.
 * cycleSummary() above is the release view.
 *
 * NOTE: spu/[spuId]/+page.svelte has its own local const of the same name
 * holding only the pass/fail modalities it renders columns for. They are
 * different lists on purpose — don't import this one over that one without
 * reading both.
 *
 * `sessionTypes` are the validation_sessions `type` strings each test writes.
 * Magnetometer has two because early sessions used 'magnetometer' before the
 * writers settled on 'mag'.
 */
/**
 * `graded` marks the instruments that record a verdict in a rollup on the unit
 * (mag, thermo). `auto` marks the two "does everything work" tests whose
 * verdict is derived on read from the run data (validation-autograde.ts):
 * Optical Bench and Blank Cartridge. Sonic is still capture-only — its run IS
 * the finished state (confirmed with Alejandro 2026-09-10).
 *
 * Listed in WORKFLOW ORDER (2026-10-06): cheapest, broadest checks first, so a
 * bad unit is weeded out before the slower fixture tests. Optical
 * confirmation is banked — see VALIDATION_INSTRUMENTS.
 */
export const VALIDATION_TESTS = [
	{ key: 'bench', name: 'Optical Bench', source: 'session', graded: false, auto: true, sessionTypes: ['laser', 'dark', 'laser_scan'] },
	{ key: 'sonic', name: 'Sonic Fingerprint', source: 'session', graded: false, auto: false, sessionTypes: ['sonic'] },
	{ key: 'blank', name: 'Blank Cartridge', source: 'blankRun', graded: false, auto: true, sessionTypes: [] },
	{ key: 'magnetometer', name: 'Magnetometer', source: 'session', graded: true, auto: false, sessionTypes: ['mag', 'magnetometer'] },
	{ key: 'thermocouple', name: 'Thermocouple', source: 'session', graded: true, auto: false, sessionTypes: ['thermo'] }
] as const;

export type ValidationTestKey = (typeof VALIDATION_TESTS)[number]['key'];

/**
 * What one dot shows:
 *   needed — no run since servicing (red)
 *   ran    — graded/auto test ran but is not passing this cycle (amber)
 *   passed — graded/auto test passed this cycle, or the capture-only test
 *            (sonic) has its evidence (green)
 */
export type TestRunState = 'needed' | 'ran' | 'passed';

export interface TestRunSince {
	key: ValidationTestKey;
	name: string;
	/** Most recent run of this test on this unit, ever — ISO, or null if never run. */
	lastRunAt: string | null;
	/** True when that run happened at/after the unit last entered servicing. */
	ranSinceServicing: boolean;
	/** False for sonic / blank / bench, which record no verdict. */
	graded: boolean;
	/** This cycle's rollup verdict; null for ungraded tests. */
	status: CycleStatus | null;
	/** Auto-graded tests: the latest run's verdict (null when not supplied / never run). */
	autoVerdict: AutoVerdict | null;
	state: TestRunState;
}

export interface RunsSinceServicing {
	tests: TestRunSince[];
	ran: number;
	/** Tests whose dot is green — what the x/N badge counts. */
	passed: number;
	total: number;
	/** The servicing-button moment everything is compared against. */
	resetAt: string | null;
}

function toIso(at: Date | string | null | undefined): string | null {
	if (!at) return null;
	const d = new Date(at);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function newest(...candidates: (Date | string | null | undefined)[]): string | null {
	const times = candidates
		.map(toIso)
		.filter((x): x is string => x !== null)
		.map((x) => new Date(x).getTime());
	return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/**
 * Which of the tests have a run newer than `validationResetAt`.
 *
 * Pure — the caller supplies the evidence it already loaded. A unit that has
 * never been serviced has no reset, so every test it has ever run counts;
 * a test with no run at all never counts, reset or not.
 */
export function runsSinceServicing(input: {
	validation?: Record<
		string,
		{ status?: string; completedAt?: Date | string | null } | null | undefined
	> | null;
	validationResetAt?: Date | string | null;
	/** This unit's validation_sessions (any type). */
	sessions?: { type?: string | null; startedAt?: Date | string | null; createdAt?: Date | string | null }[] | null;
	/** Newest optical_blank_runs.receivedAt for this unit. */
	blankRunAt?: Date | string | null;
	/**
	 * Verdicts of the latest bench / blank runs (validation-autograde-load.ts).
	 * When omitted, an auto test that ran reads green as before.
	 */
	autoVerdicts?: Partial<Record<'bench' | 'blank', AutoVerdict | null>> | null;
}): RunsSinceServicing {
	const resetAt = toIso(input.validationResetAt);
	const sessions = input.sessions ?? [];
	const validation = input.validation ?? {};

	const tests = VALIDATION_TESTS.map((t) => {
		let lastRunAt: string | null = null;

		const rollup = validation[t.key] ?? null;

		if (t.source === 'session') {
			const types = t.sessionTypes as readonly string[];
			const fromSessions = newest(
				...sessions
					.filter((s) => types.includes(String(s.type ?? '')))
					.map((s) => s.startedAt ?? s.createdAt ?? null)
			);
			// A graded test is evidenced by either surface. Sessions are the raw
			// run record; the rollup is what the Device card's x/3 reads. Taking
			// the newer of the two stops the dots and that counter disagreeing
			// when one surface lags (optics needs a sync, mag/thermo do not).
			lastRunAt = t.graded ? newest(fromSessions, rollup?.completedAt ?? null) : fromSessions;
		} else {
			lastRunAt = toIso(input.blankRunAt ?? null);
		}

		// inCurrentCycle() treats "no reset" as everything counting, which would
		// make a never-run test read as run. Require an actual run first.
		const ranSinceServicing = lastRunAt !== null && inCurrentCycle(lastRunAt, resetAt);

		// cycleStatus() already discounts a verdict earned before this cycle, so a
		// stale 'passed' from before the servicing click cannot hold a dot green.
		const status = t.graded ? cycleStatus(rollup, resetAt) : null;
		const autoVerdict = t.auto ? (input.autoVerdicts?.[t.key as 'bench' | 'blank'] ?? null) : null;
		const state: TestRunState = !ranSinceServicing
			? 'needed'
			: t.graded
				? isPassed(status) ? 'passed' : 'ran'
				: autoVerdict && autoVerdict !== 'pass'
					? 'ran'
					: 'passed';

		return { key: t.key, name: t.name, lastRunAt, ranSinceServicing, graded: t.graded, status, autoVerdict, state };
	});

	return {
		tests,
		ran: tests.filter((t) => t.ranSinceServicing).length,
		passed: tests.filter((t) => t.state === 'passed').length,
		total: VALIDATION_TESTS.length,
		resetAt
	};
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
