/**
 * Scanner sweep — production "Scan Cartridges" flow.
 * POST /api/scanner/sweep
 *   {
 *     robotId: string,
 *     positionSetId?: string,    // defaults to robot's isDefault set
 *     deviceId?: string,         // defaults to 'lab-mac-scanner-1'
 *     source?: 'wax_filling' | 'reagent_filling' | 'manual' | 'test',
 *     contextRef?: string        // e.g. wax run id
 *   }
 *
 * Flow per slot (in slotIndex order):
 *   1. moveToCoordinates(x, y, z) inside a maintenance run
 *   2. insert ScannerTrigger
 *   3. wait for matching ScannerEvent (matched by metadata.triggerId)
 *   4. record barcode (or capture error)
 * Bookended by home-before / home-after / close-maintenance-run.
 *
 * Returns { scans: [{slotIndex,x,y,z,barcode,scannedAt}], errors: [...] }.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB,
	OpentronsRobot,
	OpentronsScannerPositionSet,
	ScannerTrigger,
	ScannerEvent,
	AuditLog,
	generateId
} from '$lib/server/db';
import { getRobot } from '$lib/server/opentrons/proxy';

/**
 * Resolve a robotId to an OpentronsRobot record. The wax/reagent filling
 * flows pass an Equipment robotId (e.g. "robot-1") which may not match
 * OpentronsRobot._id directly — fall back to the legacyRobotId mapping.
 */
async function resolveRobot(rawId: string) {
	let robot = await getRobot(rawId);
	if (robot) return robot;
	await connectDB();
	const byLegacy = (await OpentronsRobot.findOne({ legacyRobotId: rawId, isActive: { $ne: false } }).lean()) as any;
	return byLegacy || null;
}
import {
	openMaintenanceRun,
	closeMaintenanceRun,
	discoverPipette,
	loadPipetteInRun,
	home,
	moveTo
} from '$lib/server/opentrons/maintenance';

export const config = { maxDuration: 300 };

const VALID_SOURCES = new Set(['wax_filling', 'reagent_filling', 'manual', 'test']);
const SCAN_WAIT_TIMEOUT_MS = 15_000;
const SCAN_POLL_INTERVAL_MS = 200;

// Scanner deviceId convention: ot2-<slot>-scanner, where slot is the trailing
// R/B + two digits in the OpentronsRobot.name field ("Robot 3 B07" → b07).
// Bridge daemons on each OT-2 poll triggers under this id, so this has to
// match the robot the sweep is targeting.
function deviceIdForRobot(robotName: string | undefined): string {
	const match = (robotName ?? '').match(/\b([A-Z]\d{2})\b/);
	const slot = match?.[1]?.toLowerCase();
	return slot ? `ot2-${slot}-scanner` : 'unknown-scanner';
}

async function waitForScanEvent(
	deviceId: string,
	triggerId: string,
	since: Date,
	timeoutMs = SCAN_WAIT_TIMEOUT_MS
): Promise<{ ok: boolean; barcode?: string; rawPayload?: string; receivedAt?: Date; errorMessage?: string }> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const ev: any = await ScannerEvent.findOne({
			deviceId,
			eventType: { $in: ['scan', 'error'] },
			receivedAt: { $gte: since },
			'metadata.triggerId': triggerId
		})
			.sort({ receivedAt: 1 })
			.lean();
		if (ev) {
			if (ev.eventType === 'scan' && ev.barcode) {
				return {
					ok: true,
					barcode: ev.barcode,
					rawPayload: ev.rawPayload,
					receivedAt: ev.receivedAt
				};
			}
			return {
				ok: false,
				errorMessage: ev.errorMessage || 'scanner returned error',
				receivedAt: ev.receivedAt
			};
		}
		await new Promise((r) => setTimeout(r, SCAN_POLL_INTERVAL_MS));
	}
	return { ok: false, errorMessage: `timed out waiting for scan event after ${timeoutMs}ms` };
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	const user = locals.user; // narrowed for use inside async closures below

	const body = await request.json().catch(() => ({} as any));
	const robotId = body?.robotId?.toString().trim();
	const positionSetId = body?.positionSetId?.toString().trim() || null;
	const source = VALID_SOURCES.has(body?.source) ? body.source : 'manual';
	const contextRef = body?.contextRef?.toString() || undefined;
	const rawMaxSlots = Number(body?.maxSlots);
	const maxSlotsRequested =
		Number.isFinite(rawMaxSlots) && rawMaxSlots > 0 ? Math.floor(rawMaxSlots) : null;

	if (!robotId) error(400, 'robotId required');

	const robot = await resolveRobot(robotId);
	if (!robot) error(404, 'Robot not found');
	const opentronsRobotId = robot._id as string;
	const deviceId =
		body?.deviceId?.toString().trim() || deviceIdForRobot(robot.name as string | undefined);

	await connectDB();

	const set: any = positionSetId
		? await OpentronsScannerPositionSet.findById(positionSetId).lean()
		: await OpentronsScannerPositionSet.findOne({ robotId: opentronsRobotId, isDefault: true }).lean();

	if (!set) error(404, positionSetId ? 'Position set not found' : 'No default position set for this robot — teach one first');
	if (set.robotId !== opentronsRobotId) error(400, 'Position set does not belong to this robot');

	const slotsToWalk = Math.min(
		set.positionCount,
		maxSlotsRequested ?? set.positionCount
	);

	// Verify all slots we plan to walk have been taught (slots beyond
	// slotsToWalk can stay unfilled without blocking).
	const positionsBySlot = new Map<number, { x: number; y: number; z: number }>();
	for (const p of set.positions ?? []) {
		positionsBySlot.set(p.slotIndex, { x: p.x, y: p.y, z: p.z });
	}
	const missing: number[] = [];
	for (let i = 0; i < slotsToWalk; i++) {
		if (!positionsBySlot.has(i)) missing.push(i);
	}
	if (missing.length > 0) {
		error(
			400,
			`Position set "${set.title}" is incomplete — slots not taught (0..${slotsToWalk - 1}): ${missing.join(', ')}`
		);
	}

	const sweepStartedAt = new Date();
	const scans: Array<{
		slotIndex: number;
		x: number;
		y: number;
		z: number;
		barcode: string;
		rawPayload?: string;
		scannedAt: Date;
	}> = [];
	const errors: Array<{ slotIndex: number; message: string }> = [];

	let runId: string | null = null;
	let pipetteId: string | undefined;
	let abortReason: string | null = null;

	try {
		// 1. Open maintenance run + ensure a pipette is loaded for motion.
		({ runId } = await openMaintenanceRun(robot));

		const pipetteName = set.pipetteName as string | undefined;
		const pipetteMount = (set.pipetteMount as 'left' | 'right' | undefined) ?? 'left';

		if (pipetteName && pipetteMount) {
			pipetteId = await loadPipetteInRun(robot, runId, pipetteName, pipetteMount);
		} else {
			const discovered = await discoverPipette(robot);
			if (!discovered) {
				throw new Error(
					'No pipette mounted on the robot — sweep requires a pipette as the motion reference axis. Configure pipetteName/mount on the position set.'
				);
			}
			pipetteId = await loadPipetteInRun(robot, runId, discovered.pipetteName, discovered.mount);
		}

		// 2. Home before sweep.
		await home(robot, runId);

		// Trigger + wait once. Used inside the per-slot retry loop below.
		const triggerAndWait = async () => {
			const triggerInsertedAt = new Date();
			const trigger = await ScannerTrigger.create({
				_id: generateId(),
				deviceId,
				requestedBy: user._id,
				requestedByUsername: user.username,
				source,
				contextRef,
				requestedAt: triggerInsertedAt,
				consumedAt: null
			});
			return waitForScanEvent(deviceId, trigger._id, triggerInsertedAt);
		};

		// 3. Walk slots in order.
		for (let slotIndex = 0; slotIndex < slotsToWalk; slotIndex++) {
			const pos = positionsBySlot.get(slotIndex)!;

			try {
				await moveTo(robot, runId, pipetteId!, { x: pos.x, y: pos.y, z: pos.z });
			} catch (e) {
				errors.push({
					slotIndex,
					message: `move-to failed: ${e instanceof Error ? e.message : String(e)}`
				});
				continue;
			}

			// First attempt. If it fails (scanner error or empty payload), retry
			// exactly once before recording the failure and moving on.
			let result = await triggerAndWait();
			let attempts = 1;
			if (!(result.ok && result.barcode)) {
				result = await triggerAndWait();
				attempts = 2;
			}

			if (result.ok && result.barcode) {
				scans.push({
					slotIndex,
					x: pos.x,
					y: pos.y,
					z: pos.z,
					barcode: result.barcode,
					rawPayload: result.rawPayload,
					scannedAt: result.receivedAt ?? new Date()
				});
			} else {
				errors.push({
					slotIndex,
					message: `${result.errorMessage ?? 'unknown scanner failure'} (after ${attempts} attempt${attempts === 1 ? '' : 's'})`
				});
			}
		}

		// 4. Home after sweep.
		await home(robot, runId);
	} catch (e) {
		abortReason = e instanceof Error ? e.message : String(e);
		console.error('[scanner/sweep] aborted:', abortReason);
	} finally {
		if (runId) {
			try {
				await closeMaintenanceRun(robot, runId);
			} catch (e) {
				console.warn('[scanner/sweep] close maintenance run failed:', e instanceof Error ? e.message : e);
			}
		}
	}

	const completedAt = new Date();

	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_scanner_sweeps',
		recordId: set._id,
		action: 'sweep',
		newData: {
			robotId: opentronsRobotId,
			rawRobotId: robotId,
			positionSetId: set._id,
			deviceId,
			source,
			contextRef,
			slotsWalked: slotsToWalk,
			scanCount: scans.length,
			errorCount: errors.length,
			abortReason,
			startedAt: sweepStartedAt,
			completedAt
		},
		changedAt: completedAt,
		changedBy: locals.user.username
	});

	if (abortReason && scans.length === 0) {
		error(502, abortReason);
	}

	return json({
		robotId: opentronsRobotId,
		positionSetId: set._id,
		title: set.title,
		positionCount: set.positionCount,
		slotsWalked: slotsToWalk,
		scans,
		errors,
		abortReason,
		startedAt: sweepStartedAt.toISOString(),
		completedAt: completedAt.toISOString()
	});
};
