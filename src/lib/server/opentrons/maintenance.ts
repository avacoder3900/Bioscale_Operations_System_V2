/**
 * OT-2 maintenance-run helpers.
 *
 * The OT-2 HTTP API only accepts gantry-motion commands inside a "maintenance
 * run" context. This module wraps that lifecycle so callers can:
 *   1. open a maintenance run (and optionally load a pipette to use as the
 *      motion reference axis for moveToCoordinates/moveRelative)
 *   2. send commands (home, moveRelative, moveToCoordinates, ...)
 *   3. read current gantry position
 *   4. close the run
 *
 * All command POSTs use intent='setup' which is the maintenance-run flavor.
 */

import { robotPost, robotGet, robotDelete } from './proxy';

/** Axis names accepted by moveRelative on OT-2 (left/right Z is per pipette mount) */
export type JogAxis = 'x' | 'y' | 'leftZ' | 'rightZ';

export type RobotRef = { ip: string; port?: number | null };

/** Open a new maintenance run. Returns the run id. */
export async function openMaintenanceRun(robot: RobotRef): Promise<{ runId: string }> {
	// OT-2 maintenance_runs endpoint is JSON:API style — requires the `data`
	// envelope even when there are no attributes. Empty body returns
	// `Field required` at /data.
	const res = await robotPost(robot as any, '/maintenance_runs', { data: {} });
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(
			(body as any)?.errors?.[0]?.detail ?? `Robot returned ${res.status} on /maintenance_runs`
		);
	}
	const body = (await res.json()) as { data?: { id?: string } };
	const runId = body?.data?.id;
	if (!runId) throw new Error('Robot did not return a maintenance run id');
	return { runId };
}

/** Close (delete) a maintenance run. Best-effort — does not throw on 404. */
export async function closeMaintenanceRun(robot: RobotRef, runId: string): Promise<void> {
	const res = await robotDelete(robot as any, `/maintenance_runs/${runId}`);
	if (!res.ok && res.status !== 404) {
		const body = await res.json().catch(() => ({}));
		throw new Error(
			(body as any)?.errors?.[0]?.detail ?? `Robot returned ${res.status} on close maintenance run`
		);
	}
}

/**
 * Send a command into a maintenance run. waitUntilComplete=true makes the
 * robot block until the command settles before returning, which is what
 * jog/move callers want (so the response position is final).
 */
export async function sendMaintenanceCommand(
	robot: RobotRef,
	runId: string,
	commandType: string,
	params: Record<string, unknown>,
	opts: { waitUntilComplete?: boolean; timeoutMs?: number } = {}
): Promise<any> {
	const waitUntilComplete = opts.waitUntilComplete ?? true;
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const qs = new URLSearchParams();
	if (waitUntilComplete) qs.set('waitUntilComplete', 'true');
	if (timeoutMs) qs.set('timeout', String(timeoutMs));
	const path = `/maintenance_runs/${runId}/commands?${qs.toString()}`;
	const res = await robotPost(robot as any, path, {
		data: { commandType, intent: 'setup', params }
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(
			(body as any)?.errors?.[0]?.detail ?? `Robot returned ${res.status} on command ${commandType}`
		);
	}
	// CRITICAL: the OT-2 returns HTTP 201 even when a command failed; the
	// per-command status lives at body.data.status. A "failed" status with
	// no http error here is the difference between a sweep that silently
	// no-ops the gantry and one that fails loudly. Detect it.
	const body: any = await res.json();
	const innerStatus = body?.data?.status;
	if (innerStatus === 'failed') {
		const err = body?.data?.error ?? {};
		const detail = err.detail ?? err.errorType ?? 'unknown command failure';
		const type = err.errorType ? `[${err.errorType}] ` : '';
		throw new Error(`${commandType} failed: ${type}${detail}`);
	}
	return body;
}

/**
 * Discover an available pipette on the robot. Prefers left mount.
 * Returns the OT-2's pipette name (e.g. 'p20_single_gen2') and mount.
 * The maintenance run uses pipette name + mount via loadPipette to allocate
 * a per-run pipetteId — that id is what subsequent motion commands need.
 */
export async function discoverPipette(
	robot: RobotRef,
	preferredMount?: 'left' | 'right' | null
): Promise<{ pipetteName: string; mount: 'left' | 'right' } | null> {
	try {
		const res = await robotGet(robot as any, '/pipettes');
		if (!res.ok) return null;
		const body = (await res.json()) as Record<string, { name?: string; model?: string }>;
		// /pipettes returns { left: {name|model, ...}, right: {...} }. We need the
		// `name` (technical id like 'p20_single_gen2'); `model` is also accepted
		// as a fallback. Honor preferredMount when both mounts are populated.
		const mounts: Array<'left' | 'right'> =
			preferredMount === 'left'
				? ['left', 'right']
				: preferredMount === 'right'
					? ['right', 'left']
					: ['left', 'right'];
		for (const m of mounts) {
			const entry = body?.[m];
			if (entry?.name) return { pipetteName: entry.name, mount: m };
		}
		for (const m of mounts) {
			const entry = body?.[m];
			if (entry?.model) return { pipetteName: entry.model, mount: m };
		}
		return null;
	} catch (e) {
		// Log the underlying reason (ECONNREFUSED etc.) so the failure path is
		// visible in Vercel function logs; we still return null so the caller can
		// proceed to openMaintenanceRun, which will surface the same error.
		console.warn('[discoverPipette] failed:', e instanceof Error ? e.message : e);
		return null;
	}
}

/**
 * Load a pipette into the maintenance run. Returns the run-scoped pipetteId
 * that subsequent moveToCoordinates / moveRelative commands need.
 */
export async function loadPipetteInRun(
	robot: RobotRef,
	runId: string,
	pipetteName: string,
	mount: 'left' | 'right'
): Promise<string> {
	const result = (await sendMaintenanceCommand(
		robot,
		runId,
		'loadPipette',
		{ pipetteName, mount },
		{ waitUntilComplete: true }
	)) as { data?: { result?: { pipetteId?: string } } };
	const pid = result?.data?.result?.pipetteId;
	if (!pid) throw new Error('loadPipette did not return a pipetteId');
	return pid;
}

/** Home all axes (or a specific subset). */
export async function home(
	robot: RobotRef,
	runId: string,
	axes?: Array<'x' | 'y' | 'leftZ' | 'rightZ' | 'leftPlunger' | 'rightPlunger'>
): Promise<void> {
	await sendMaintenanceCommand(
		robot,
		runId,
		'home',
		axes ? { axes } : {},
		{ waitUntilComplete: true, timeoutMs: 60_000 }
	);
}

/** Jog (relative move) on a single axis. */
export async function jog(
	robot: RobotRef,
	runId: string,
	pipetteId: string,
	axis: JogAxis,
	distance: number
): Promise<void> {
	await sendMaintenanceCommand(
		robot,
		runId,
		'moveRelative',
		{ pipetteId, axis, distance },
		{ waitUntilComplete: true, timeoutMs: 30_000 }
	);
}

/** Move to absolute deck coordinates. */
export async function moveTo(
	robot: RobotRef,
	runId: string,
	pipetteId: string,
	coords: { x: number; y: number; z: number },
	opts: { minimumZHeight?: number; forceDirect?: boolean } = {}
): Promise<void> {
	await sendMaintenanceCommand(
		robot,
		runId,
		'moveToCoordinates',
		{
			pipetteId,
			coordinates: coords,
			...(opts.minimumZHeight !== undefined ? { minimumZHeight: opts.minimumZHeight } : {}),
			...(opts.forceDirect !== undefined ? { forceDirect: opts.forceDirect } : {})
		},
		{ waitUntilComplete: true, timeoutMs: 30_000 }
	);
}

/**
 * Read current gantry position from the robot (deck coordinates).
 * The OT-2 surfaces this via GET /robot/positions which returns multiple
 * named positions; the "current" position is the one most recently moved to.
 * We expose savePosition + getRunPosition off the maintenance run instead.
 */
export async function getCurrentPosition(
	robot: RobotRef,
	runId: string,
	pipetteId: string
): Promise<{ x: number; y: number; z: number } | null> {
	// savePosition is the maintenance-run command that records the current head
	// position and returns it in the command result. Calling this gives us a
	// reliable XYZ readback after jog/move commands.
	const result = (await sendMaintenanceCommand(
		robot,
		runId,
		'savePosition',
		{ pipetteId },
		{ waitUntilComplete: true, timeoutMs: 10_000 }
	)) as { data?: { result?: { position?: { x: number; y: number; z: number } } } };
	const p = result?.data?.result?.position;
	if (!p) return null;
	return { x: p.x, y: p.y, z: p.z };
}
