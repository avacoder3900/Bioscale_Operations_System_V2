/**
 * Reagent-filling robot service types.
 */

export interface ReagentRobotRunState {
	robotId: string;
	name: string;
	description: string | null;
	hasActiveRun: boolean;
	runId: string | null;
	stage: string | null;
	assayTypeName: string | null;
	runStartTime: string | null;
	runEndTime: string | null;
	cartridgeCount: number;
	/** Runs that have completed the robot phase and are in post-robot stages (Inspection, Sealing, Storage) */
	postRobotRuns: {
		runId: string;
		stage: string;
		cartridgeCount: number;
		assayTypeName: string | null;
	}[];
}
