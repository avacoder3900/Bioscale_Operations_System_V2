/**
 * Typed helpers for the Opentrons OT-2 `/maintenance_runs` API surface.
 *
 * Maintenance runs are the OT-2's mechanism for ad-hoc operator-driven motion
 * without polluting the "runs" history. The Labware Position Check (LPC) wizard
 * (OT-D2) drives a maintenance run under the hood: load pipette + labware,
 * pick up tip, move to each reference well, jog, save positions.
 *
 * All helpers return the robot's response body verbatim (no DB, no caching,
 * no AuditLog — per guardrails). Failures surface the robot's error detail.
 */
import createClient from 'openapi-fetch';
import type { components, paths } from './openapi-types';
import { robotBaseUrl, type OpentronsClient, type RobotEndpoint } from './client';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const HTTP_MARGIN_MS = 5_000;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

export type MaintenanceRun = components['schemas']['MaintenanceRun'];

type CreateResponse = components['schemas']['SimpleBody_MaintenanceRun_'];

/**
 * Typed union of the command-create payloads LPC needs. Each element matches
 * its `*Create` schema in the live OpenAPI and is accepted by
 * `POST /maintenance_runs/{runId}/commands`.
 */
export type MaintenanceCommand =
	| components['schemas']['HomeCreate']
	| components['schemas']['LoadPipetteCreate']
	| components['schemas']['LoadLabwareCreate']
	| components['schemas']['PickUpTipCreate']
	| components['schemas']['MoveToWellCreate']
	| components['schemas']['MoveRelativeCreate']
	| components['schemas']['SavePositionCreate']
	| components['schemas']['DropTipCreate'];

export const ALLOWED_COMMAND_TYPES = [
	'home',
	'loadPipette',
	'loadLabware',
	'pickUpTip',
	'moveToWell',
	'moveRelative',
	'savePosition',
	'dropTip'
] as const;
export type AllowedCommandType = (typeof ALLOWED_COMMAND_TYPES)[number];

export function isAllowedCommandType(s: unknown): s is AllowedCommandType {
	return typeof s === 'string' && (ALLOWED_COMMAND_TYPES as readonly string[]).includes(s);
}

/**
 * Minimal shape of an executed command. The live API's discriminated union is
 * huge; every variant has `id`, `commandType`, `status`, and optional
 * `result`/`error`, which is everything callers need.
 */
export interface MaintenanceCommandResult {
	id: string;
	commandType: string;
	status: string;
	result?: Record<string, unknown> | null;
	error?: Record<string, unknown> | null;
	[k: string]: unknown;
}

function rawClient(robot: RobotEndpoint, timeoutMs: number): OpentronsClient {
	const client = createClient<paths>({ baseUrl: robotBaseUrl(robot) });
	client.use({
		async onRequest({ request }) {
			if (!request.headers.has('opentrons-version')) {
				request.headers.set('opentrons-version', '*');
			}
			if (request.signal) return request;
			return new Request(request, { signal: AbortSignal.timeout(timeoutMs) });
		}
	});
	return client;
}

function formatRobotError(action: string, status: number | undefined, body: unknown): Error {
	let detail = '';
	try {
		detail = JSON.stringify(body);
	} catch {
		detail = String(body);
	}
	return new Error(`Opentrons ${action} failed (${status ?? '?'}): ${detail}`);
}

/**
 * Create a new maintenance run on the robot.
 *
 * @throws if the robot is unreachable or returns a non-2xx response.
 */
export async function createMaintenanceRun(robot: RobotEndpoint): Promise<MaintenanceRun> {
	const client = rawClient(robot, DEFAULT_HTTP_TIMEOUT_MS);
	// `as any`: openapi-fetch's generated types require `params.header['opentrons-version']`
	// explicitly on every call. Our client.ts middleware injects that header for every
	// request, so the callsite version is redundant but TS can't infer that. The `body`
	// is still typed against the generated Create schemas — schema drift on the payload
	// IS detected. What we lose is method/path mistyping, which `npm run check` would
	// only catch on the cast-free path.
	const res = await (client as any).POST('/maintenance_runs', {
		body: { data: {} }
	});
	if (res.error !== undefined) {
		throw formatRobotError('createMaintenanceRun', res.response?.status, res.error);
	}
	const body = res.data as CreateResponse | undefined;
	if (!body?.data?.id) {
		throw formatRobotError('createMaintenanceRun', res.response?.status, res.data);
	}
	return body.data;
}

/**
 * Delete a maintenance run. Idempotent — 404s (run already gone) are swallowed.
 */
/**
 * Register a custom labware definition on an existing maintenance run.
 *
 * Maintenance runs don't inherit the protocol's uploaded labware — a fresh
 * session starts with only the standard Opentrons labware registered. For
 * any custom labware (Brevitest's cartridges, wax trays, etc.), we have to
 * POST the full definition JSON into the session before `loadLabware` by
 * namespace/loadName/version can succeed.
 *
 * @throws if the robot rejects the definition.
 */
export async function registerMaintenanceLabwareDefinition(
	robot: RobotEndpoint,
	runId: string,
	definition: unknown
): Promise<void> {
	const client = rawClient(robot, DEFAULT_HTTP_TIMEOUT_MS);
	const res = await (client as any).POST('/maintenance_runs/{runId}/labware_definitions', {
		params: { path: { runId } },
		body: { data: definition }
	});
	if (res.error !== undefined) {
		throw formatRobotError('registerMaintenanceLabwareDefinition', res.response?.status, res.error);
	}
}

export async function endMaintenanceRun(robot: RobotEndpoint, runId: string): Promise<void> {
	const client = rawClient(robot, DEFAULT_HTTP_TIMEOUT_MS);
	const res = await (client as any).DELETE('/maintenance_runs/{runId}', {
		params: { path: { runId } }
	});
	if (res.error !== undefined) {
		if (res.response?.status === 404) return;
		throw formatRobotError('endMaintenanceRun', res.response?.status, res.error);
	}
}

/**
 * If the robot is already holding a current maintenance run, tear it down.
 * Called before creating a new session so orphans from crashed sessions don't
 * block the next LPC attempt.
 */
export async function endOrphanMaintenanceRuns(robot: RobotEndpoint): Promise<number> {
	const client = rawClient(robot, DEFAULT_HTTP_TIMEOUT_MS);
	const res = await (client as any).GET('/maintenance_runs/current_run', {});
	if (res.error !== undefined) {
		if (res.response?.status === 404) return 0;
		throw formatRobotError('endOrphanMaintenanceRuns', res.response?.status, res.error);
	}
	const currentId = (res.data as { data?: { id?: string } } | undefined)?.data?.id;
	if (!currentId) return 0;
	await endMaintenanceRun(robot, currentId);
	return 1;
}

/**
 * Enqueue a single command on a maintenance run, waiting for completion.
 *
 * The robot's `waitUntilComplete` param makes the request block until the
 * command succeeds or fails; the HTTP-level timeout is extended beyond that
 * by a small margin so the robot's own timeout fires first with a useful body.
 *
 * Throws if the HTTP call fails OR if the command itself resolved to
 * `status === "failed"` or carries an `error`.
 */
export async function enqueueCommand(
	robot: RobotEndpoint,
	runId: string,
	command: MaintenanceCommand,
	options: { timeoutMs?: number } = {}
): Promise<MaintenanceCommandResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	const client = rawClient(robot, timeoutMs + HTTP_MARGIN_MS);
	const res = await (client as any).POST('/maintenance_runs/{runId}/commands', {
		params: {
			path: { runId },
			query: { waitUntilComplete: true, timeout: timeoutMs }
		},
		body: { data: command }
	});
	if (res.error !== undefined) {
		throw formatRobotError(`enqueueCommand(${command.commandType})`, res.response?.status, res.error);
	}
	const body = res.data as { data: MaintenanceCommandResult } | undefined;
	const result = body?.data;
	if (!result) {
		throw formatRobotError(
			`enqueueCommand(${command.commandType})`,
			res.response?.status,
			res.data
		);
	}
	if (result.status === 'failed' || result.error) {
		throw formatRobotError(
			`enqueueCommand(${command.commandType})`,
			res.response?.status,
			result.error ?? result
		);
	}
	return result;
}

// ---- Typed convenience wrappers (one per command type LPC needs) ----

type Mount = components['schemas']['opentrons__types__MountType'];
type MotorAxis = components['schemas']['MotorAxis'];
type MovementAxis = components['schemas']['MovementAxis'];
type PipetteName = components['schemas']['PipetteNameType'];
type LoadLabwareParams = components['schemas']['LoadLabwareParams'];
type PickUpTipParams = components['schemas']['PickUpTipParams'];
type MoveToWellParams = components['schemas']['MoveToWellParams'];
type DropTipParams = components['schemas']['DropTipParams'];

export function loadPipette(
	robot: RobotEndpoint,
	runId: string,
	mount: Mount,
	pipetteName: PipetteName,
	options: { timeoutMs?: number } = {}
): Promise<MaintenanceCommandResult> {
	const cmd: components['schemas']['LoadPipetteCreate'] = {
		commandType: 'loadPipette',
		params: { mount, pipetteName }
	};
	return enqueueCommand(robot, runId, cmd, options);
}

export function loadLabware(
	robot: RobotEndpoint,
	runId: string,
	params: LoadLabwareParams,
	options: { timeoutMs?: number } = {}
): Promise<MaintenanceCommandResult> {
	const cmd: components['schemas']['LoadLabwareCreate'] = {
		commandType: 'loadLabware',
		params
	};
	return enqueueCommand(robot, runId, cmd, options);
}

export function pickUpTip(
	robot: RobotEndpoint,
	runId: string,
	params: PickUpTipParams,
	options: { timeoutMs?: number } = {}
): Promise<MaintenanceCommandResult> {
	const cmd: components['schemas']['PickUpTipCreate'] = {
		commandType: 'pickUpTip',
		params
	};
	return enqueueCommand(robot, runId, cmd, options);
}

export function moveToWell(
	robot: RobotEndpoint,
	runId: string,
	params: MoveToWellParams,
	options: { timeoutMs?: number } = {}
): Promise<MaintenanceCommandResult> {
	const cmd: components['schemas']['MoveToWellCreate'] = {
		commandType: 'moveToWell',
		params
	};
	return enqueueCommand(robot, runId, cmd, options);
}

export function jog(
	robot: RobotEndpoint,
	runId: string,
	pipetteId: string,
	axis: MovementAxis,
	distance: number,
	options: { timeoutMs?: number } = {}
): Promise<MaintenanceCommandResult> {
	const cmd: components['schemas']['MoveRelativeCreate'] = {
		commandType: 'moveRelative',
		params: { pipetteId, axis, distance }
	};
	return enqueueCommand(robot, runId, cmd, options);
}

export function savePosition(
	robot: RobotEndpoint,
	runId: string,
	pipetteId: string,
	options: { timeoutMs?: number } = {}
): Promise<MaintenanceCommandResult> {
	const cmd: components['schemas']['SavePositionCreate'] = {
		commandType: 'savePosition',
		params: { pipetteId }
	};
	return enqueueCommand(robot, runId, cmd, options);
}

export function dropTip(
	robot: RobotEndpoint,
	runId: string,
	params: DropTipParams,
	options: { timeoutMs?: number } = {}
): Promise<MaintenanceCommandResult> {
	const cmd: components['schemas']['DropTipCreate'] = {
		commandType: 'dropTip',
		params
	};
	return enqueueCommand(robot, runId, cmd, options);
}

export function homeAxes(
	robot: RobotEndpoint,
	runId: string,
	axes?: MotorAxis[],
	options: { timeoutMs?: number } = {}
): Promise<MaintenanceCommandResult> {
	const cmd: components['schemas']['HomeCreate'] = {
		commandType: 'home',
		params: axes ? { axes } : {}
	};
	return enqueueCommand(robot, runId, cmd, options);
}

