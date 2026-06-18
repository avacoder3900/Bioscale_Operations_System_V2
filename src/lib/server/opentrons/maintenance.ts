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

// A protocol run left non-terminal (commonly a `paused` run from the off-deck
// initial pause that was never resumed/closed) keeps holding the OT-2 run
// engine, so the robot refuses new maintenance runs with this error. We
// auto-clear the stale run and retry — the same self-heal the bridge daemon
// does for deck-scan/sweep (scripts/ot2-bridge.py).
const PROTOCOL_RUN_CONFLICT = 'protocol run is active';
const ACTIVE_RUN_STATES = new Set(['running', 'finishing']);
const TERMINAL_RUN_STATES = new Set(['stopped', 'failed', 'succeeded']);

async function currentProtocolRun(
	robot: RobotRef
): Promise<{ id: string; status: string | null } | null> {
	const res = await robotGet(robot as any, '/runs');
	if (!res.ok) return null;
	const body = (await res.json().catch(() => ({}))) as any;
	const href: string = body?.links?.current?.href ?? '';
	const curId = href ? href.split('/').pop() ?? null : null;
	if (!curId) return null;
	const run = (body?.data ?? []).find((r: any) => r.id === curId);
	return { id: curId, status: run?.status ?? null };
}

/**
 * Free the run engine when a non-terminal protocol run is blocking a new
 * maintenance run. Throws if the blocking run is genuinely ACTIVE
 * (running/finishing) — we never silently kill a live run.
 */
async function clearStaleProtocolRun(robot: RobotRef): Promise<void> {
	const run = await currentProtocolRun(robot);
	if (!run) return;
	const status = (run.status ?? '').toLowerCase();
	if (TERMINAL_RUN_STATES.has(status)) return; // terminal-but-current doesn't block
	if (ACTIVE_RUN_STATES.has(status)) {
		throw new Error(
			`Robot has an ACTIVE protocol run (status=${status}) — stop that run before opening a maintenance run.`
		);
	}
	// Stale: paused / idle / blocked-by-open-door / stop-requested / awaiting-recovery
	await robotPost(robot as any, `/runs/${run.id}/actions`, {
		data: { actionType: 'stop' }
	}).catch(() => {});
	for (let i = 0; i < 6; i++) {
		const cur = await currentProtocolRun(robot);
		if (!cur || TERMINAL_RUN_STATES.has((cur.status ?? '').toLowerCase())) break;
		await new Promise((r) => setTimeout(r, 500));
	}
	await robotDelete(robot as any, `/runs/${run.id}`).catch(() => {});
}

/** Open a new maintenance run. Returns the run id. */
export async function openMaintenanceRun(robot: RobotRef): Promise<{ runId: string }> {
	// OT-2 maintenance_runs endpoint is JSON:API style — requires the `data`
	// envelope even when there are no attributes. Empty body returns
	// `Field required` at /data.
	const open = async () => robotPost(robot as any, '/maintenance_runs', { data: {} });
	let res = await open();
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as any;
		const detail = body?.errors?.[0]?.detail ?? `Robot returned ${res.status} on /maintenance_runs`;
		if (String(detail).toLowerCase().includes(PROTOCOL_RUN_CONFLICT)) {
			await clearStaleProtocolRun(robot); // throws if genuinely active
			res = await open();
			if (!res.ok) {
				const retryBody = (await res.json().catch(() => ({}))) as any;
				throw new Error(
					retryBody?.errors?.[0]?.detail ??
						`Robot returned ${res.status} on /maintenance_runs`
				);
			}
		} else {
			throw new Error(detail);
		}
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
	// Client HTTP timeout must exceed the robot-side waitUntilComplete hold
	// (timeoutMs) or slow commands like home abort early as "fetch failed".
	const res = await robotPost(robot as any, path, {
		data: { commandType, intent: 'setup', params }
	}, { timeoutMs: timeoutMs + 10_000 });
	if (!res.ok) {
		const body: any = await res.json().catch(() => ({}));
		// Opentrons command errors use {errors:[{detail}]}; FastAPI request-validation
		// (422) uses {detail:[{loc,msg}]} — surface the field path so "field required"
		// is actually diagnosable instead of a bare message.
		const fastapiDetail = Array.isArray(body?.detail)
			? body.detail.map((d: any) => `${(d?.loc ?? []).join('.')}: ${d?.msg ?? ''}`).join('; ')
			: typeof body?.detail === 'string'
				? body.detail
				: null;
		const detail = body?.errors?.[0]?.detail ?? fastapiDetail ?? body?.message;
		throw new Error(`${commandType}: ${detail ?? `robot returned ${res.status}`}`);
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

/** Home all axes (or a specific subset).
 *  The schema marks `axes` optional ("omit = home all"), but some OT-2 firmware
 *  rejects an empty params object with a "field required" validation error, so we
 *  ALWAYS send the explicit full OT-2 axis set when no subset is given. */
const OT2_ALL_AXES = ['x', 'y', 'leftZ', 'rightZ', 'leftPlunger', 'rightPlunger'] as const;
export async function home(
	robot: RobotRef,
	runId: string,
	axes?: Array<'x' | 'y' | 'leftZ' | 'rightZ' | 'leftPlunger' | 'rightPlunger'>
): Promise<void> {
	await sendMaintenanceCommand(
		robot,
		runId,
		'home',
		{ axes: axes ?? [...OT2_ALL_AXES] },
		{ waitUntilComplete: true, timeoutMs: 60_000 }
	);
}

/** Jog (relative move) on a single axis.
 *  The caller may pass leftZ/rightZ (the home-style MotorAxis), but moveRelative's
 *  axis is a MovementAxis ('x'|'y'|'z') — the mount is already fixed by pipetteId,
 *  so map both Z variants to 'z'. (leftZ/rightZ here caused "input should be
 *  'x','y' or 'z'" from the robot.) */
export async function jog(
	robot: RobotRef,
	runId: string,
	pipetteId: string,
	axis: JogAxis,
	distance: number
): Promise<void> {
	const moveAxis = axis === 'leftZ' || axis === 'rightZ' ? 'z' : axis;
	await sendMaintenanceCommand(
		robot,
		runId,
		'moveRelative',
		{ pipetteId, axis: moveAxis, distance },
		{ waitUntilComplete: true, timeoutMs: 30_000 }
	);
}

/**
 * Move to absolute deck coordinates. forceDirect defaults to true here
 * because scanner sweeps don't pick up tips, don't transport liquid, and
 * don't otherwise need the safety-arc routing — direct point-to-point cuts
 * ~0.5-1s off every slot transition.
 */
export async function moveTo(
	robot: RobotRef,
	runId: string,
	pipetteId: string,
	coords: { x: number; y: number; z: number },
	opts: { minimumZHeight?: number; forceDirect?: boolean } = {}
): Promise<void> {
	const forceDirect = opts.forceDirect ?? true;
	await sendMaintenanceCommand(
		robot,
		runId,
		'moveToCoordinates',
		{
			pipetteId,
			coordinates: coords,
			...(opts.minimumZHeight !== undefined ? { minimumZHeight: opts.minimumZHeight } : {}),
			forceDirect
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

/**
 * Register a custom labware definition onto a maintenance run so a subsequent
 * loadLabware (by namespace/loadName/version) can resolve it. Required for the
 * deck-calibration "move to hole" (DECK-CALIBRATION-STUDIO) since the deck is a
 * custom Opentrons def. Mirrors maintenance-clone.registerMaintenanceLabwareDefinition
 * but over the bridge-capable robotPost transport.
 */
export async function registerLabwareDefinition(
	robot: RobotRef,
	runId: string,
	definition: unknown
): Promise<void> {
	const res = await robotPost(robot as any, `/maintenance_runs/${runId}/labware_definitions`, {
		data: definition
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(
			(body as any)?.errors?.[0]?.detail ?? `Robot returned ${res.status} registering labware definition`
		);
	}
}

/** Load a (already-registered) labware def into the run at a slot; returns labwareId. */
export async function loadLabwareInRun(
	robot: RobotRef,
	runId: string,
	args: { namespace: string; loadName: string; version: number; slot: string }
): Promise<string> {
	const result = (await sendMaintenanceCommand(
		robot,
		runId,
		'loadLabware',
		{
			location: { slotName: args.slot },
			loadName: args.loadName,
			namespace: args.namespace,
			version: args.version
		},
		{ waitUntilComplete: true, timeoutMs: 30_000 }
	)) as { data?: { result?: { labwareId?: string } } };
	const id = result?.data?.result?.labwareId;
	if (!id) throw new Error('loadLabware did not return a labwareId');
	return id;
}

/**
 * Move the pipette to a well's nominal position (default: just above the well top).
 * Travels as a SAFE ARC, not a straight line: with forceDirect=false the OT-2 lifts
 * to `minimumZHeight` (deck Z, mm) first, moves over the target in XY, then descends.
 * This avoids dragging the tip across cartridges/structures between holes. The
 * caller passes a high minimumZHeight (≈80mm above the holes) so the lift always
 * clears the deck.
 */
export async function moveToWell(
	robot: RobotRef,
	runId: string,
	pipetteId: string,
	labwareId: string,
	wellName: string,
	opts: { zOffsetMm?: number; minimumZHeight?: number } = {}
): Promise<void> {
	await sendMaintenanceCommand(
		robot,
		runId,
		'moveToWell',
		{
			pipetteId,
			labwareId,
			wellName,
			wellLocation: { origin: 'top', offset: { x: 0, y: 0, z: opts.zOffsetMm ?? 2 } },
			// false ⇒ travel via the safe arc (up to minimumZHeight, over, down).
			forceDirect: false,
			...(opts.minimumZHeight !== undefined ? { minimumZHeight: opts.minimumZHeight } : {})
		},
		{ waitUntilComplete: true, timeoutMs: 30_000 }
	);
}

/** Pick up a tip from a (loaded) tiprack — so the operator dials in with a tip on,
 *  matching the real fill/calibration workflow. */
export async function pickUpTip(
	robot: RobotRef,
	runId: string,
	pipetteId: string,
	labwareId: string,
	wellName: string
): Promise<void> {
	await sendMaintenanceCommand(
		robot,
		runId,
		'pickUpTip',
		{ pipetteId, labwareId, wellName, wellLocation: { origin: 'top', offset: { x: 0, y: 0, z: 0 } } },
		{ waitUntilComplete: true, timeoutMs: 30_000 }
	);
}
