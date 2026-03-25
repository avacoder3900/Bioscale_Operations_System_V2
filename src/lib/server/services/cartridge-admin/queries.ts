/**
 * Cartridge Admin query service — shared types and utilities.
 */

export type LifecycleStage =
	| 'backing'
	| 'wax_filling'
	| 'wax_filled'
	| 'wax_qc'
	| 'wax_stored'
	| 'reagent_filled'
	| 'inspected'
	| 'sealed'
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
	| 'received';

export const LIFECYCLE_STAGES: LifecycleStage[] = [
	'backing',
	'wax_filling',
	'wax_filled',
	'wax_qc',
	'wax_stored',
	'reagent_filled',
	'inspected',
	'sealed',
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
