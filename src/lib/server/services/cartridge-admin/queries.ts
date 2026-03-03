/**
 * Cartridge Admin query service — shared types and utilities.
 */

export type LifecycleStage =
	| 'Backed'
	| 'Wax Filling'
	| 'Cooled'
	| 'Reagent Filling'
	| 'Inspected'
	| 'Top Sealed'
	| 'Stored'
	| 'Rejected'
	| 'Scrapped';

export const LIFECYCLE_STAGES: LifecycleStage[] = [
	'Backed',
	'Wax Filling',
	'Cooled',
	'Reagent Filling',
	'Inspected',
	'Top Sealed',
	'Stored',
	'Rejected',
	'Scrapped'
];

export function phaseToLifecycleStage(phase: string): LifecycleStage {
	const map: Record<string, LifecycleStage> = {
		backed: 'Backed',
		wax_filling: 'Wax Filling',
		cooling: 'Cooled',
		reagent_filling: 'Reagent Filling',
		inspected: 'Inspected',
		top_seal: 'Top Sealed',
		stored: 'Stored',
		rejected: 'Rejected',
		scrapped: 'Scrapped'
	};
	return map[phase] ?? 'Backed';
}
