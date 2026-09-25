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
import { isHardenedRobot } from '$lib/server/services/deck-calibration/rollout';
import * as ot2 from '$lib/opentrons/ot2-protocol';
import { serverTransport } from './transport';

/** Axis names accepted by moveRelative on OT-2 (left/right Z is per pipette mount) */
export type JogAxis = ot2.JogAxis;

export type RobotRef = { ip: string; port?: number | null };

/**
 * Thrown by loadLabwareInRun when the target slot already holds a DIFFERENT
 * labware in this maintenance run (e.g. the reagent tiprack was loaded to
 * calibrate it, then a wax tip pickup wants the 20µL rack in the same slot 11).
 * The OT-2 has no gripper and moveLabware/offDeck pauses the run, so the slot
 * can't be freed in place — the caller recovers by opening a fresh run instead
 * of leaking a raw LocationIsOccupiedError to the operator.
 */
export class SlotOccupiedError extends Error {
	readonly code = 'SLOT_OCCUPIED';
	constructor(
		readonly slot: string,
		readonly existingLoadName: string,
		readonly wantedLoadName: string
	) {
		super(
			`Slot ${slot} already holds ${existingLoadName}; cannot load ${wantedLoadName} there. ` +
				`Reopen the maintenance run to clear it.`
		);
		this.name = 'SlotOccupiedError';
	}
}

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
 * Send a command into a maintenance run (waitUntilComplete, failed-201 detection).
 * Moved to $lib/opentrons/ot2-protocol so the browser's tailnet line runs the
 * exact same code; this wrapper keeps the server call signature.
 */
export async function sendMaintenanceCommand(
	robot: RobotRef,
	runId: string,
	commandType: string,
	params: Record<string, unknown>,
	opts: { waitUntilComplete?: boolean; timeoutMs?: number } = {}
): Promise<any> {
	return ot2.sendMaintenanceCommand(serverTransport(robot), runId, commandType, params, opts);
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

/** Home all axes (or a subset) — see ot2-protocol.home. */
export async function home(
	robot: RobotRef,
	runId: string,
	axes?: Array<'x' | 'y' | 'leftZ' | 'rightZ' | 'leftPlunger' | 'rightPlunger'>
): Promise<void> {
	await ot2.home(serverTransport(robot), runId, axes);
}

/** Jog (relative move) on a single axis — see ot2-protocol.jog (leftZ/rightZ → z). */
export async function jog(robot: RobotRef, runId: string, pipetteId: string, axis: JogAxis, distance: number): Promise<void> {
	await ot2.jog(serverTransport(robot), runId, pipetteId, axis, distance);
}

/** Move to absolute deck coordinates (forceDirect defaults true) — see ot2-protocol.moveTo. */
export async function moveTo(
	robot: RobotRef,
	runId: string,
	pipetteId: string,
	coords: { x: number; y: number; z: number },
	opts: { minimumZHeight?: number; forceDirect?: boolean; speed?: number } = {}
): Promise<void> {
	await ot2.moveTo(serverTransport(robot), runId, pipetteId, coords, opts);
}

/** Current gantry position via savePosition — see ot2-protocol.getCurrentPosition. */
export async function getCurrentPosition(
	robot: RobotRef,
	runId: string,
	pipetteId: string
): Promise<{ x: number; y: number; z: number } | null> {
	return ot2.getCurrentPosition(serverTransport(robot), runId, pipetteId);
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
/**
 * Return the id of labware already loaded at `slot` in a maintenance run, or null.
 * A maintenance run is reused across repeated pick-up-tip / move-to-hole actions,
 * so the same tiprack/deck may already occupy the slot from an earlier call.
 */
async function loadedLabwareAtSlot(
	robot: RobotRef,
	runId: string,
	slot: string
): Promise<{ id: string; loadName: string; definitionUri: string | null } | null> {
	const res = await robotGet(robot as any, `/maintenance_runs/${runId}`);
	if (!res.ok) return null;
	const body = (await res.json().catch(() => ({}))) as any;
	const lw = (body?.data?.labware ?? []) as Array<any>;
	const match = lw.find((x) => String(x?.location?.slotName ?? '') === String(slot));
	return match?.id
		? { id: match.id, loadName: match.loadName, definitionUri: match.definitionUri ?? null }
		: null;
}

export async function loadLabwareInRun(
	robot: RobotRef,
	runId: string,
	args: { namespace: string; loadName: string; version: number; slot: string }
): Promise<string> {
	// Idempotent: re-loading the same labware into an already-occupied slot throws
	// LocationIsOccupiedError. That happens whenever this maintenance run was already
	// used to load this slot (e.g. pick up a tip, then pick up again without closing).
	// Reuse the existing labware id instead of failing.
	const existing = await loadedLabwareAtSlot(robot, runId, args.slot).catch(() => null);
	// Reuse ONLY when the full identity matches — namespace/loadName/version, not
	// loadName alone. A maintenance run binds the geometry it was given at load
	// time and keeps serving it. Matching on loadName meant that after a deck edit
	// the robot still moved to the PRE-edit coordinates while the Studio displayed
	// the new ones, so the operator jogged the same error a second time and the
	// correction silently doubled. Publishing bumps the version, so a stale bind
	// now fails this check and is reloaded.
	const wantUri = `${args.namespace}/${args.loadName}/${args.version}`;
	if (existing && existing.loadName === args.loadName) {
		// Gated per robot: on a robot that is not opted in, keep the old
		// loadName-only reuse so its jog sessions behave exactly as they do today.
		if (!isHardenedRobot(robot)) return existing.id;
		if (!existing.definitionUri || existing.definitionUri === wantUri) return existing.id;
		// Same labware, different version: the slot holds geometry we no longer
		// trust. Treat it exactly like a foreign occupant so the caller opens a
		// fresh run rather than silently calibrating against stale coordinates.
		throw new SlotOccupiedError(args.slot, existing.definitionUri, wantUri);
	}
	// A DIFFERENT labware already occupies the slot (e.g. the reagent tiprack was loaded
	// to calibrate it, then a wax tip pickup needs the 20µL rack in the same physical
	// slot 11). The OT-2 has no gripper and moveLabware/offDeck pauses the run, so the
	// slot can't be freed in place — surface a typed, recoverable signal the caller
	// (pick-up-tip endpoint) turns into a fresh run instead of a raw LocationIsOccupiedError.
	if (existing && existing.loadName !== args.loadName) {
		throw new SlotOccupiedError(args.slot, existing.loadName, args.loadName);
	}

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

/** Move to a well via the safe arc — see ot2-protocol.moveToWell. */
export async function moveToWell(
	robot: RobotRef,
	runId: string,
	pipetteId: string,
	labwareId: string,
	wellName: string,
	opts: { zOffsetMm?: number; minimumZHeight?: number; xOffsetMm?: number; yOffsetMm?: number } = {}
): Promise<void> {
	await ot2.moveToWell(serverTransport(robot), runId, pipetteId, labwareId, wellName, opts);
}

/** Drop whatever tip the run models into the fixed trash — see ot2-protocol.dropTipInTrash. */
export async function dropTipInTrash(robot: RobotRef, runId: string, pipetteId: string): Promise<void> {
	await ot2.dropTipInTrash(serverTransport(robot), runId, pipetteId);
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
