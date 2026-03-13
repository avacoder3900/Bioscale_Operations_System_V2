/**
 * Wax-filling robot service types.
 */

export interface RobotRunAlert {
	type: string;
	message: string;
	severity?: 'info' | 'warning' | 'error';
}

export interface RobotRunState {
	robotId: string;
	name: string;
	description: string | null;
	hasActiveRun: boolean;
	runId: string | null;
	stage: string | null;
	runStartTime: Date | string | null;
	runEndTime: Date | string | null;
	deckId: string | null;
	alerts: RobotRunAlert[];
}
