/**
 * Canonical status sets for WaxFillingRun and ReagentBatchRecord.
 *
 * Both schemas define `status` as a loose `String` with no enum constraint,
 * and the codebase historically writes status values in BOTH cases — wax
 * runs lean lowercase ('completed', 'aborted'), reagent runs lean
 * capitalized ('Completed', 'Cancelled', 'Aborted'). At time of writing
 * production held:
 *
 *   wax_filling_runs:        completed=40 aborted=29 Aborted=3 voided=1
 *   reagent_batch_records:   Completed=27 Cancelled=13 Aborted=9 completed=1
 *
 * Filters that hardcode one case silently miss data — a
 * `status: { $in: ['completed'] }` find returns ~93% of completed wax runs
 * but only ~4% of completed reagent runs. Always import sets from this
 * module instead of inlining string arrays. If you need a new bucket, add
 * it here.
 */

// === Page-owned: operator is actively driving the run on its page ===

/** Wax runs the operator is actively driving on the wax-filling page. */
export const WAX_PAGE_OWNED = [
	'Setup', 'Loading', 'Running', 'Awaiting Removal',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling'
] as const;

/** Reagent runs the operator is actively driving on the reagent-filling page. */
export const REAGENT_PAGE_OWNED = [
	'Setup', 'Loading', 'Running', 'Inspection',
	'setup', 'loading', 'running', 'inspection'
] as const;

// === Filling-active: OT-2 is physically executing the protocol ===

/** Wax run statuses where the OT-2 is physically executing the protocol. */
export const WAX_FILLING_ACTIVE = ['Setup', 'Running', 'setup', 'running'] as const;

/** Reagent run statuses where the OT-2 is physically executing the protocol. */
export const REAGENT_FILLING_ACTIVE = ['Setup', 'Running', 'setup', 'running'] as const;

// === Non-terminal: anything that is not done/aborted/cancelled/voided ===

/** Wax run statuses that are not terminal. */
export const WAX_NON_TERMINAL = [
	'Setup', 'Loading', 'Running', 'Awaiting Removal', 'QC', 'Storage',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling', 'qc', 'storage'
] as const;

/** Reagent run statuses that are not terminal. */
export const REAGENT_NON_TERMINAL = [
	'Setup', 'Loading', 'Running', 'Inspection', 'Top Sealing', 'Storage',
	'setup', 'loading', 'running', 'inspection', 'top_sealing', 'storage'
] as const;

// === Terminal sets — for wax AND reagent ===

/** Run finished cleanly, both casings. */
export const COMPLETED = ['completed', 'Completed'] as const;

/** Aborted or cancelled, both casings. */
export const ABORTED_OR_CANCELLED = [
	'aborted', 'Aborted', 'cancelled', 'Cancelled'
] as const;

/** Voided, both casings. */
export const VOIDED = ['voided', 'Voided'] as const;

/** Every terminal value that means "done, regardless of outcome." */
export const ANY_TERMINAL = [
	...COMPLETED, ...ABORTED_OR_CANCELLED, ...VOIDED
] as const;
