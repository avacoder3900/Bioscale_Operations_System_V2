// VALIDATION-05: standard acceptance range applied to thermocouple data
// uploaded through a validation run. Values are TBD by the team (PRD OQ-1) —
// while null, run uploads park at 'uploaded' and Evaluate stays disabled.
// The standalone /validation/thermocouple page is unaffected (operator-entered
// range there, as before).
export interface ThermoCriteria {
	minTemp: number;
	maxTemp: number;
}

export const STANDARD_THERMO_CRITERIA: ThermoCriteria | null = null;
