/**
 * Manufacturing Pipeline widget — shared by the home page (/) and
 * /cartridge-dashboard so the two can't drift apart again.
 *
 * One bar per cartridge status, in lifecycle order. Every count is a
 * CartridgeRecord status count and nothing else: the bucket system
 * (BUCKET-SYSTEM_PLAN.md §2) made 'backing' a per-cartridge status, so the
 * legacy BackingLot.cartridgeCount sum — which nothing has written since
 * WAX-FLOW-2 — is no longer part of the Backed bar.
 */
export const PIPELINE_PHASES = [
	// Bucket stages (BUCKET-SYSTEM_PLAN §2). 'backing' is shown as "Backed".
	'barcoded', 'unpressed', 'backing',
	'wax_filling', 'wax_filled', 'wax_qc', 'wax_ready', 'wax_rejected',
	'reagent_filling', 'reagent_filled', 'inspected', 'sealed', 'reagent_qc', 'reagent_ready', 'reagent_rejected',
	'cured', 'stored', 'released', 'shipped'
] as const;

const PHASE_LABELS: Record<string, string> = { backing: 'Backed' };

export function buildPipeline(phaseCounts: { _id: string; count: number }[]) {
	const counts = new Map(phaseCounts.map((p) => [p._id, p.count]));
	return PIPELINE_PHASES.map((phase) => ({
		phase,
		count: counts.get(phase) ?? 0,
		label: PHASE_LABELS[phase] ?? phase.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
	}));
}
