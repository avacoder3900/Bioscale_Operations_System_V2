/**
 * Wax-filling robot service types.
 */

export interface RobotRunAlert {
	type: string;
	message: string;
	severity?: 'info' | 'warning' | 'error';
}

export interface RobotHealthSummary {
	status: 'ready' | 'busy' | 'hung' | 'offline';
	label: string;
	detail: string;
	bridgeOnline: boolean;
	serverOk: boolean;
	engineOk: boolean;
	protocolRun: string | null;
	maintenanceRun: string | null;
	lastBeatMsAgo: number | null;
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
	cartridgeCount?: number;
	health?: RobotHealthSummary | null;
	alerts: RobotRunAlert[];
	activeProcess?: 'wax' | 'reagent' | null;
}
