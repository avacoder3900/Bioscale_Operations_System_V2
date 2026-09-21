/**
 * Wax-stage cartridge status doctrine (WAX-SIMPLIFY-1..3, 2026-08-17).
 *
 *   backing → wax_filling → wax_filled ─┬─→ (reagent filling)
 *                                        ├─→ wax_ready   (legacy / future CV verdict; also → reagent)
 *                                        └─→ wax_rejected (visual reject on Wax Reject; off-ramp)
 *
 * `wax_filled` IS the stored state — the fridge scan at deck removal records
 * waxStorage.location but does not change status. Passing visual inspection is
 * implicit (no status change); only rejects are recorded, with a photo.
 * `wax_stored` and `wax_qc` are retired: they remain in historical rows /
 * AuditLog only and are folded into wax_filled by scripts/migrate-wax-simplify.ts.
 */

/** Carts sitting in the wax stage (bench or fridge) that reagent filling may take. */
export const WAX_STAGE_STATUSES = ['wax_filled', 'wax_ready'] as const;
export type WaxStageStatus = (typeof WAX_STAGE_STATUSES)[number];

/** Retired wax statuses that may still exist on unmigrated production rows. */
export const LEGACY_WAX_STATUSES = ['wax_stored', 'wax_qc'] as const;

/** Statuses the Wax Reject page will accept a scan for (→ wax_rejected). */
export const WAX_REJECTABLE_STATUSES = [...WAX_STAGE_STATUSES, ...LEGACY_WAX_STATUSES] as const;

/** Lifecycle order for the wax segment, used by phaseOrder / STAGES lists. */
export const WAX_ORDER = ['backing', 'wax_filling', 'wax_filled', 'wax_ready', 'wax_rejected'] as const;

export function isWaxStage(status: string | null | undefined): status is WaxStageStatus {
	return (WAX_STAGE_STATUSES as readonly string[]).includes(status ?? '');
}

/**
 * The single reagent-filling admission rule (WAX-SIMPLIFY-3). Used by BOTH the
 * live validate-equipment scan check and the reagent-filling startRun gate so
 * they can never disagree.
 */
export function isReagentEligible(status: string | null | undefined): { ok: true } | { ok: false; hint: string } {
	if (isWaxStage(status)) return { ok: true };
	const s = status ?? 'none';
	if (s === 'wax_rejected') return { ok: false, hint: 'it was rejected at wax inspection' };
	if (s === 'backing' || s === 'wax_filling') return { ok: false, hint: "it hasn't finished wax filling" };
	if ((LEGACY_WAX_STATUSES as readonly string[]).includes(s)) {
		return { ok: false, hint: `legacy status "${s}" — run scripts/migrate-wax-simplify.ts` };
	}
	if (s.startsWith('reagent_') || ['sealed', 'stored', 'released', 'shipped', 'linked', 'underway', 'completed'].includes(s)) {
		return { ok: false, hint: `it is already past wax (status=${s})` };
	}
	return { ok: false, hint: `it is in phase "${s}"` };
}
