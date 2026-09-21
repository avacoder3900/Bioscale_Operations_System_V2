/**
 * Cartridge Admin query service — shared types and utilities.
 */

export type LifecycleStage =
	| 'backing'
	| 'wax_filling'
	| 'wax_filled'
	| 'wax_qc' // retired (WAX-SIMPLIFY-2) — historical rows only
	| 'wax_ready'
	| 'wax_rejected'
	| 'reagent_filled'
	| 'inspected'
	| 'sealed'
	| 'reagent_qc'
	| 'reagent_ready'
	| 'reagent_rejected'
	| 'cured'
	| 'stored'
	| 'released'
	| 'shipped'
	| 'linked'
	| 'underway'
	| 'completed'
	| 'cancelled'
	| 'scrapped'
	| 'voided'
	| 'packeted'
	| 'transferred'
	| 'refrigerated'
	| 'received'
	| 'assay_loaded'
	| 'testing';

export const LIFECYCLE_STAGES: LifecycleStage[] = [
	'backing',
	'wax_filling',
	'wax_filled',
	'wax_qc',
	'wax_ready',
	'wax_rejected',
	'reagent_filled',
	'inspected',
	'sealed',
	'reagent_qc',
	'reagent_ready',
	'reagent_rejected',
	'cured',
	'stored',
	'released',
	'shipped',
	'linked',
	'underway',
	'completed',
	'cancelled',
	'scrapped',
	'voided',
	'packeted',
	'transferred',
	'refrigerated',
	'received'
];

export function statusToLifecycleStage(status: string): LifecycleStage {
	// Status values now map directly to lifecycle stages
	if (LIFECYCLE_STAGES.includes(status as LifecycleStage)) return status as LifecycleStage;
	return 'backing';
}
