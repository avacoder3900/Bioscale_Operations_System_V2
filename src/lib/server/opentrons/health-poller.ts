/**
 * Singleton health poller. Pings all active robots every POLL_INTERVAL_MS.
 * In-memory state only — no DB writes per Step 1 thin-client rule.
 * Robot list is read from OpentronsRobot (preexisting on master) as a read-only source.
 */

import { connectDB, OpentronsRobot } from '$lib/server/db';
import { robotBaseUrl } from './proxy';

const POLL_INTERVAL_MS = 15_000;
const ROBOT_TIMEOUT_MS = 3_000;

export interface RobotHealthState {
	robotId: string;
	name: string;
	ip: string;
	port: number;
	isOnline: boolean;
	apiVersion: string | null;
	firmwareVersion: string | null;
	robotSerial: string | null;
	leftPipette: { name: string; model: string } | null;
	rightPipette: { name: string; model: string } | null;
	currentRunId: string | null;
	currentRunStatus: string | null;
	lastCheckedAt: Date;
	responseTimeMs: number | null;
	errorMessage: string | null;
}

const healthStore = new Map<string, RobotHealthState>();
let pollerInterval: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(states: RobotHealthState[]) => void>();

export function getHealthStates(): RobotHealthState[] {
	return Array.from(healthStore.values());
}

export function subscribeHealth(cb: (states: RobotHealthState[]) => void): () => void {
	listeners.add(cb);
	cb(getHealthStates());
	return () => listeners.delete(cb);
}

async function pollRobot(robot: { _id: string; name: string; ip: string; port?: number }): Promise<RobotHealthState> {
	const baseUrl = robotBaseUrl({ ip: robot.ip, port: robot.port ?? 31950 });
	const start = Date.now();
	const state: RobotHealthState = {
		robotId: String(robot._id),
		name: robot.name ?? '',
		ip: robot.ip,
		port: robot.port ?? 31950,
		isOnline: false,
		apiVersion: null,
		firmwareVersion: null,
		robotSerial: null,
		leftPipette: null,
		rightPipette: null,
		currentRunId: null,
		currentRunStatus: null,
		lastCheckedAt: new Date(),
		responseTimeMs: null,
		errorMessage: null,
	};

	try {
		const healthRes = await fetch(`${baseUrl}/health`, {
			signal: AbortSignal.timeout(ROBOT_TIMEOUT_MS),
			headers: { 'opentrons-version': '3' },
		});
		state.responseTimeMs = Date.now() - start;

		if (!healthRes.ok) {
			state.errorMessage = `HTTP ${healthRes.status}`;
			return state;
		}

		const health = await healthRes.json();
		state.isOnline = true;
		state.apiVersion = health.api_version ?? null;
		state.firmwareVersion = health.fw_version ?? null;
		state.robotSerial = health.robot_serial ?? null;

		try {
			const runsRes = await fetch(`${baseUrl}/runs?pageLength=1`, {
				signal: AbortSignal.timeout(ROBOT_TIMEOUT_MS),
				headers: { 'opentrons-version': '3' },
			});
			if (runsRes.ok) {
				const runsData = await runsRes.json();
				const runs = runsData.data ?? [];
				if (runs.length > 0) {
					const latest = runs[0];
					if (['running', 'paused', 'finishing', 'awaiting-recovery'].includes(latest.status)) {
						state.currentRunId = latest.id;
						state.currentRunStatus = latest.status;
					}
				}
			}
		} catch { /* non-critical */ }
	} catch (e) {
		state.responseTimeMs = Date.now() - start;
		state.errorMessage = e instanceof Error ? e.message : 'Unknown error';
	}

	return state;
}

async function pollAllRobots() {
	try {
		await connectDB();
		const robots = await OpentronsRobot.find({ isActive: true })
			.select('_id name ip port')
			.lean();

		const results = await Promise.allSettled(
			(robots as any[]).map((r) => pollRobot(r))
		);

		for (const result of results) {
			if (result.status === 'fulfilled') {
				healthStore.set(result.value.robotId, result.value);
			}
		}

		const states = getHealthStates();
		for (const cb of listeners) {
			try { cb(states); } catch { /* listener error */ }
		}
	} catch (e) {
		console.error('[health-poller] poll cycle error:', e);
	}
}

export function startPoller() {
	if (pollerInterval) return;
	pollAllRobots();
	pollerInterval = setInterval(pollAllRobots, POLL_INTERVAL_MS);
}

export function stopPoller() {
	if (pollerInterval) {
		clearInterval(pollerInterval);
		pollerInterval = null;
	}
}
