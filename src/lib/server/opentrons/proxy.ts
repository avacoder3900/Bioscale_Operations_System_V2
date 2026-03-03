/**
 * Opentrons OT-2 HTTP proxy helpers.
 * Provides utilities for forwarding requests to robot HTTP APIs.
 */

import { connectDB, OpentronsRobot, generateId } from '$lib/server/db';

const DEFAULT_PORT = 31950;

/** Get a robot record by DB id and assert it's active */
export async function getRobot(id: string) {
	await connectDB();
	const robot = await OpentronsRobot.findById(id).lean() as any;
	if (!robot || robot.isActive === false) return null;
	return robot;
}

/** Build the base URL for a robot's HTTP API */
export function robotBaseUrl(robot: { ip: string; port?: number | null }): string {
	const port = robot.port ?? DEFAULT_PORT;
	return `http://${robot.ip}:${port}`;
}

/** Proxy a GET request to the robot */
export async function robotGet(robot: any, path: string): Promise<Response> {
	const url = `${robotBaseUrl(robot)}${path}`;
	return fetch(url, {
		headers: { 'opentrons-version': '3' }
	});
}

/** Proxy a POST request to the robot */
export async function robotPost(robot: any, path: string, body?: unknown): Promise<Response> {
	const url = `${robotBaseUrl(robot)}${path}`;
	return fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'opentrons-version': '3'
		},
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
}

/** Proxy a PATCH request to the robot */
export async function robotPatch(robot: any, path: string, body?: unknown): Promise<Response> {
	const url = `${robotBaseUrl(robot)}${path}`;
	return fetch(url, {
		method: 'PATCH',
		headers: {
			'Content-Type': 'application/json',
			'opentrons-version': '3'
		},
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
}

/** Proxy a DELETE request to the robot */
export async function robotDelete(robot: any, path: string): Promise<Response> {
	const url = `${robotBaseUrl(robot)}${path}`;
	return fetch(url, {
		method: 'DELETE',
		headers: { 'opentrons-version': '3' }
	});
}

/** Parse and forward a robot response */
export async function forwardResponse(res: Response): Promise<{ data: unknown; status: number }> {
	const data = await res.json().catch(() => null);
	return { data, status: res.status };
}

/** Save last known health to robot record */
export async function updateRobotHealth(
	robotId: string,
	isHealthy: boolean,
	snapshot?: Record<string, unknown>
): Promise<void> {
	await OpentronsRobot.updateOne(
		{ _id: robotId },
		{
			lastHealthAt: new Date(),
			lastHealthOk: isHealthy,
			...(snapshot ? {
				$push: {
					recentHealthSnapshots: {
						$each: [{ ...snapshot, isHealthy, createdAt: new Date() }],
						$slice: -20 // Keep last 20 snapshots
					}
				}
			} : {})
		}
	);
}
