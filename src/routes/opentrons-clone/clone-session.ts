/**
 * One robot session for the Opentrons UI (OT2-TAILNET-5 §7.8).
 *
 * The clone is a browser app: every +page.ts load and every action reaches the
 * robot through ONE RobotSession per robot (direct over Tailscale, or the BIMS
 * relay/queue), shared by the layout's pill and the page. Navigating to another
 * robot closes the previous session; the robots list page closes it too.
 */
import { error } from '@sveltejs/kit';
import { RobotSession } from '$lib/opentrons/direct-client';
import { sessionRobotClient, type OpentronsClient } from '$lib/opentrons/robot-client';

export interface CloneRobot {
	_id: string;
	name: string;
	ip: string;
	port?: number;
}

export interface CloneLine {
	robotId: string;
	session: RobotSession;
	client: OpentronsClient;
	/** Resolves once the session has decided its line (never rejects). */
	ready: Promise<CloneLine>;
}

let current: CloneLine | null = null;

/** The page-wide session for a robot (created and opened on first use). */
export function cloneLine(robotId: string): CloneLine {
	if (current?.robotId === robotId) return current;
	current?.session.close();
	const session = new RobotSession(robotId);
	const line = { robotId, session, client: sessionRobotClient(session) } as CloneLine;
	line.ready = session.open().then(() => line);
	current = line;
	return line;
}

/** Close the current session (leaving the robot pages). */
export function closeCloneLine(): void {
	current?.session.close();
	current = null;
}

/** The robot record from the layout gate's Mongo list; 404 when it isn't there. */
export function robotFrom(robots: CloneRobot[] | undefined, robotId: string): CloneRobot {
	const robot = (robots ?? []).find((r) => r._id === robotId);
	if (!robot) throw error(404, 'Robot not found');
	return robot;
}
