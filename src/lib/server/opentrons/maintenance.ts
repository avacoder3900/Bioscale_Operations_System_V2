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

import { isHardenedRobot } from '$lib/server/services/deck-calibration/rollout';
import * as ot2 from '$lib/opentrons/ot2-protocol';
import { serverTransport } from './transport';

/** Axis names accepted by moveRelative on OT-2 (left/right Z is per pipette mount) */
export type JogAxis = ot2.JogAxis;

export type RobotRef = { ip: string; port?: number | null };

// OT2-TAILNET-4: the maintenance-run lifecycle below delegates to
// $lib/opentrons/ot2-protocol so the browser's tailnet line runs the same code.
export { SlotOccupiedError } from '$lib/opentrons/ot2-protocol';

/** Open a new maintenance run (clears a stale protocol run first). Returns the run id. */
export async function openMaintenanceRun(robot: RobotRef): Promise<{ runId: string }> {
	return ot2.openMaintenanceRun(serverTransport(robot));
}

/** Close (delete) a maintenance run. Best-effort — does not throw on 404. */
export async function closeMaintenanceRun(robot: RobotRef, runId: string): Promise<void> {
	await ot2.closeMaintenanceRun(serverTransport(robot), runId);
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

/** Discover an available pipette (prefers left mount) — see ot2-protocol.discoverPipette. */
export async function discoverPipette(
	robot: RobotRef,
	preferredMount?: 'left' | 'right' | null
): Promise<{ pipetteName: string; mount: 'left' | 'right' } | null> {
	return ot2.discoverPipette(serverTransport(robot), preferredMount);
}

/** Load a pipette into the maintenance run; returns the run-scoped pipetteId. */
export async function loadPipetteInRun(robot: RobotRef, runId: string, pipetteName: string, mount: 'left' | 'right'): Promise<string> {
	return ot2.loadPipetteInRun(serverTransport(robot), runId, pipetteName, mount);
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

/** Register a custom labware definition onto a maintenance run. */
export async function registerLabwareDefinition(robot: RobotRef, runId: string, definition: unknown): Promise<void> {
	await ot2.registerLabwareDefinition(serverTransport(robot), runId, definition);
}

/** Load a registered labware def at a slot (idempotent; hardened reuse per DECK_HARDENING_ROBOT_IDS). */
export async function loadLabwareInRun(
	robot: RobotRef,
	runId: string,
	args: { namespace: string; loadName: string; version: number; slot: string }
): Promise<string> {
	return ot2.loadLabwareInRun(serverTransport(robot), runId, args, { hardened: isHardenedRobot(robot) });
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

/** Pick up a tip from a (loaded) tiprack — see ot2-protocol.pickUpTip. */
export async function pickUpTip(robot: RobotRef, runId: string, pipetteId: string, labwareId: string, wellName: string): Promise<void> {
	await ot2.pickUpTip(serverTransport(robot), runId, pipetteId, labwareId, wellName);
}
