/**
 * Cartridge Admin query service — shared types and utilities.
 */

export type LifecycleStage =
	| 'backing'
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
	| 'assay_loaded'
	| 'testing'
	| 'completed'
	| 'voided';

export const LIFECYCLE_STAGES: LifecycleStage[] = [
	'backing',
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
	'assay_loaded',
	'testing',
	'completed',
	'voided'
];

export function phaseToLifecycleStage(phase: string): LifecycleStage {
	// Phase values now map directly to lifecycle stages
	if (LIFECYCLE_STAGES.includes(phase as LifecycleStage)) return phase as LifecycleStage;
	return 'backing';
}
