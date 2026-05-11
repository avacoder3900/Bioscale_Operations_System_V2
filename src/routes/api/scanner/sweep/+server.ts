/**
 * Scanner sweep — production "Scan Cartridges" flow.
 * POST /api/scanner/sweep
 *   {
 *     robotId: string,
 *     positionSetId?: string,    // defaults to robot's isDefault set
 *     deviceId?: string,         // defaults to ot2-<slot>-scanner derived from robot.name
 *     source?: 'wax_filling' | 'reagent_filling' | 'manual' | 'test',
 *     contextRef?: string,       // e.g. wax run id
 *     maxSlots?: number          // cap; defaults to set.positionCount
 *   }
 *
 * Returns IMMEDIATELY with the sweepRunId. Sweep itself runs in the
 * background; client polls GET /api/scanner/sweep/<id> for live status,
 * and can POST cancel/pause/resume signals to stop or hold the gantry
 * between slots.
 *
 * Per-slot loop on the background worker:
 *   1. moveToCoordinates(x, y, z) inside a maintenance run
 *   2. insert ScannerTrigger
 *   3. wait for matching ScannerEvent (matched by metadata.triggerId)
 *   4. retry once on scanner failure, then record barcode or error
 *   5. check SweepRun.cancelRequested / pauseRequested between slots
 * Bookended by home-before / home-after / close-maintenance-run.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB,
	OpentronsRobot,
	OpentronsScannerPositionSet,
	OpentronsScannerSweepRun,
	ScannerTrigger,
	ScannerEvent,
	AuditLog,
	generateId
} from '$lib/server/db';
import { getRobot } from '$lib/server/opentrons/proxy';
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
const PAUSE_POLL_INTERVAL_MS = 500;

// Scanner deviceId convention: ot2-<slot>-scanner, where slot is the trailing
// R/B + two digits in the OpentronsRobot.name field ("Robot 3 B07" → b07).
function deviceIdForRobot(robotName: string | undefined): string {
	const match = (robotName ?? '').match(/\b([A-Z]\d{2})\b/);
	const slot = match?.[1]?.toLowerCase();
	return slot ? `ot2-${slot}-scanner` : 'unknown-scanner';
}

async function resolveRobot(rawId: string) {
	let robot = await getRobot(rawId);
	if (robot) return robot;
	await connectDB();
	const byLegacy = (await OpentronsRobot.findOne({ legacyRobotId: rawId, isActive: { $ne: false } }).lean()) as any;
	return byLegacy || null;
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

async function appendLog(
	sweepRunId: string,
	level: 'info' | 'warn' | 'error',
	message: string,
	slotIndex?: number
): Promise<void> {
	await OpentronsScannerSweepRun.findByIdAndUpdate(sweepRunId, {
		$push: { log: { ts: new Date(), level, message, slotIndex } }
	}).lean();
}

async function readControlFlags(
	sweepRunId: string
): Promise<{ status: string; pauseRequested: boolean; cancelRequested: boolean }> {
	const doc: any = await OpentronsScannerSweepRun.findById(sweepRunId)
		.select('status pauseRequested cancelRequested')
		.lean();
	return {
		status: doc?.status ?? 'errored',
		pauseRequested: !!doc?.pauseRequested,
		cancelRequested: !!doc?.cancelRequested
	};
}

interface RunSweepCtx {
	sweepRunId: string;
	robot: any;
	user: { _id: string; username: string };
	deviceId: string;
	source: string;
	contextRef?: string;
	set: any;
	slotsToWalk: number;
	positionsBySlot: Map<number, { x: number; y: number; z: number }>;
}

async function runSweepBackground(ctx: RunSweepCtx): Promise<void> {
	const {
		sweepRunId,
		robot,
		user,
		deviceId,
		source,
		contextRef,
		set,
		slotsToWalk,
		positionsBySlot
	} = ctx;

	let maintRunId: string | null = null;
	let pipetteId: string | undefined;
	let abortReason: string | null = null;
	const scansLocal: Array<{ slotIndex: number; barcode: string }> = [];
	const errorsLocal: Array<{ slotIndex: number; message: string }> = [];

	try {
		await appendLog(sweepRunId, 'info', 'Opening maintenance run on the OT-2…');
		({ runId: maintRunId } = await openMaintenanceRun(robot));
		await appendLog(sweepRunId, 'info', `Maintenance run open: ${maintRunId}`);

		const preferredMount = (set.pipetteMount as 'left' | 'right' | undefined) ?? undefined;
		const discovered = await discoverPipette(robot, preferredMount ?? null);
		if (!discovered) {
			throw new Error(
				'No pipette mounted on the robot — sweep requires a pipette as the motion reference axis. Mount a pipette on the OT-2 before running a sweep.'
			);
		}
		await appendLog(
			sweepRunId,
			'info',
			`Pipette discovered: ${discovered.pipetteName} on ${discovered.mount} mount`
		);
		pipetteId = await loadPipetteInRun(robot, maintRunId, discovered.pipetteName, discovered.mount);
		await appendLog(sweepRunId, 'info', `Pipette loaded into run (pipetteId=${pipetteId})`);

		await appendLog(sweepRunId, 'info', 'Homing gantry before sweep…');
		await home(robot, maintRunId);
		await appendLog(sweepRunId, 'info', 'Home complete. Walking taught positions.');

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

		for (let slotIndex = 0; slotIndex < slotsToWalk; slotIndex++) {
			// Honor pause / cancel between slots.
			let flags = await readControlFlags(sweepRunId);
			if (flags.cancelRequested || flags.status === 'cancelled') {
				abortReason = 'cancelled by operator';
				await appendLog(sweepRunId, 'warn', 'Cancel requested — exiting before next slot.');
				break;
			}
			while (flags.pauseRequested && !flags.cancelRequested) {
				await OpentronsScannerSweepRun.findByIdAndUpdate(sweepRunId, {
					$set: { status: 'paused' }
				});
				await appendLog(sweepRunId, 'info', 'Paused — waiting for resume…', slotIndex);
				// Idle-poll until the flag flips.
				while (flags.pauseRequested && !flags.cancelRequested) {
					await new Promise((r) => setTimeout(r, PAUSE_POLL_INTERVAL_MS));
					flags = await readControlFlags(sweepRunId);
				}
				if (flags.cancelRequested) break;
				await OpentronsScannerSweepRun.findByIdAndUpdate(sweepRunId, {
					$set: { status: 'running' }
				});
				await appendLog(sweepRunId, 'info', 'Resumed.', slotIndex);
			}
			if (flags.cancelRequested) {
				abortReason = 'cancelled by operator';
				await appendLog(sweepRunId, 'warn', 'Cancel requested while paused.');
				break;
			}

			const pos = positionsBySlot.get(slotIndex)!;
			await OpentronsScannerSweepRun.findByIdAndUpdate(sweepRunId, {
				$set: { currentSlotIndex: slotIndex }
			});
			await appendLog(
				sweepRunId,
				'info',
				`Slot ${slotIndex + 1}: moving to (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`,
				slotIndex
			);

			try {
				await moveTo(robot, maintRunId, pipetteId!, { x: pos.x, y: pos.y, z: pos.z });
			} catch (e) {
				const msg = `move-to failed: ${e instanceof Error ? e.message : String(e)}`;
				errorsLocal.push({ slotIndex, message: msg });
				await OpentronsScannerSweepRun.findByIdAndUpdate(sweepRunId, {
					$push: {
						errors: { slotIndex, message: msg, recordedAt: new Date(), attempts: 0 }
					},
					$inc: { slotsDone: 1 }
				});
				await appendLog(sweepRunId, 'error', `Slot ${slotIndex + 1}: ${msg}`, slotIndex);
				continue;
			}

			let result = await triggerAndWait();
			let attempts = 1;
			if (!(result.ok && result.barcode)) {
				await appendLog(
					sweepRunId,
					'warn',
					`Slot ${slotIndex + 1}: first attempt failed (${result.errorMessage ?? 'no barcode'}) — retrying`,
					slotIndex
				);
				result = await triggerAndWait();
				attempts = 2;
			}

			if (result.ok && result.barcode) {
				scansLocal.push({ slotIndex, barcode: result.barcode });
				await OpentronsScannerSweepRun.findByIdAndUpdate(sweepRunId, {
					$push: {
						scans: {
							slotIndex,
							barcode: result.barcode,
							rawPayload: result.rawPayload,
							scannedAt: result.receivedAt ?? new Date(),
							x: pos.x,
							y: pos.y,
							z: pos.z,
							attempts
						}
					},
					$inc: { slotsDone: 1 }
				});
				await appendLog(
					sweepRunId,
					'info',
					`Slot ${slotIndex + 1}: scanned "${result.barcode}" (${attempts} attempt${attempts === 1 ? '' : 's'})`,
					slotIndex
				);
			} else {
				const msg = `${result.errorMessage ?? 'unknown scanner failure'} (after ${attempts} attempts)`;
				errorsLocal.push({ slotIndex, message: msg });
				await OpentronsScannerSweepRun.findByIdAndUpdate(sweepRunId, {
					$push: {
						errors: { slotIndex, message: msg, recordedAt: new Date(), attempts }
					},
					$inc: { slotsDone: 1 }
				});
				await appendLog(sweepRunId, 'warn', `Slot ${slotIndex + 1}: ${msg}`, slotIndex);
			}
		}

		await appendLog(sweepRunId, 'info', 'Homing gantry after sweep…');
		await home(robot, maintRunId);
		await appendLog(sweepRunId, 'info', 'Home complete.');
	} catch (e) {
		abortReason = e instanceof Error ? e.message : String(e);
		console.error('[scanner/sweep] aborted:', abortReason);
		await appendLog(sweepRunId, 'error', `Sweep aborted: ${abortReason}`);
	} finally {
		if (maintRunId) {
			try {
				await closeMaintenanceRun(robot, maintRunId);
				await appendLog(sweepRunId, 'info', 'Maintenance run closed.');
			} catch (e) {
				await appendLog(
					sweepRunId,
					'warn',
					`Close maintenance run failed: ${e instanceof Error ? e.message : e}`
				);
			}
		}
	}

	const completedAt = new Date();
	const flags = await readControlFlags(sweepRunId);
	const finalStatus =
		flags.cancelRequested || abortReason === 'cancelled by operator'
			? 'cancelled'
			: abortReason
				? 'errored'
				: 'completed';

	await OpentronsScannerSweepRun.findByIdAndUpdate(sweepRunId, {
		$set: {
			status: finalStatus,
			completedAt,
			abortReason: abortReason ?? null,
			pauseRequested: false,
			cancelRequested: false,
			currentSlotIndex: null
		}
	});
	await appendLog(
		sweepRunId,
		finalStatus === 'completed' ? 'info' : 'warn',
		`Sweep ${finalStatus}. ${scansLocal.length} scan(s), ${errorsLocal.length} error(s).`
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_scanner_sweeps',
		recordId: set._id,
		action: 'sweep',
		newData: {
			sweepRunId,
			robotId: ctx.robot._id,
			positionSetId: set._id,
			deviceId,
			source,
			contextRef,
			slotsWalked: slotsToWalk,
			scanCount: scansLocal.length,
			errorCount: errorsLocal.length,
			status: finalStatus,
			abortReason
		},
		changedAt: completedAt,
		changedBy: user.username
	});
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	const user = locals.user;

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

	const slotsToWalk = Math.min(set.positionCount, maxSlotsRequested ?? set.positionCount);

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

	// Reject if there's already a running sweep for this robot — keeps state
	// machines on the OT-2 sane (one maintenance run at a time).
	const inFlight = await OpentronsScannerSweepRun.findOne({
		robotId: opentronsRobotId,
		status: { $in: ['running', 'paused'] }
	})
		.select('_id status')
		.lean();
	if (inFlight) {
		error(409, `Another sweep is already ${(inFlight as any).status} for this robot (id=${(inFlight as any)._id}). Cancel it first.`);
	}

	const sweepRun = await OpentronsScannerSweepRun.create({
		_id: generateId(),
		robotId: opentronsRobotId,
		robotName: robot.name,
		positionSetId: set._id,
		positionSetTitle: set.title,
		deviceId,
		source,
		contextRef,
		slotsTotal: slotsToWalk,
		slotsDone: 0,
		status: 'running',
		startedAt: new Date(),
		log: [
			{
				ts: new Date(),
				level: 'info',
				message: `Sweep queued: ${slotsToWalk} slot(s), set="${set.title}", robot=${robot.name}`
			}
		],
		requestedBy: user._id,
		requestedByUsername: user.username
	});

	// Fire-and-forget. Errors inside run are caught + recorded; this final
	// .catch is a last-resort safety net for anything that escapes.
	runSweepBackground({
		sweepRunId: sweepRun._id,
		robot,
		user: { _id: user._id, username: user.username },
		deviceId,
		source,
		contextRef,
		set,
		slotsToWalk,
		positionsBySlot
	}).catch(async (e) => {
		console.error('[scanner/sweep] unhandled background error:', e);
		try {
			await OpentronsScannerSweepRun.findByIdAndUpdate(sweepRun._id, {
				$set: {
					status: 'errored',
					completedAt: new Date(),
					abortReason: e instanceof Error ? e.message : String(e)
				},
				$push: {
					log: {
						ts: new Date(),
						level: 'error',
						message: `Unhandled background error: ${e instanceof Error ? e.message : String(e)}`
					}
				}
			});
		} catch {
			/* swallow — already in an error path */
		}
	});

	return json({
		sweepRunId: sweepRun._id,
		robotId: opentronsRobotId,
		positionSetId: set._id,
		positionSetTitle: set.title,
		slotsTotal: slotsToWalk
	});
};

/** GET /api/scanner/sweep — list recent sweeps (history). */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const robotId = url.searchParams.get('robotId')?.trim();
	const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 25));
	const status = url.searchParams.get('status');

	const filter: any = {};
	if (robotId) filter.robotId = robotId;
	if (status) filter.status = status;

	const docs = await OpentronsScannerSweepRun.find(filter)
		.select(
			'_id robotId robotName positionSetId positionSetTitle status slotsTotal slotsDone scans.length errors.length source contextRef startedAt completedAt requestedByUsername abortReason'
		)
		.sort({ startedAt: -1 })
		.limit(limit)
		.lean();

	// We selected scans.length / errors.length aliases — but Mongoose just
	// returns the full arrays. Project counts ourselves.
	const items = (docs as any[]).map((d) => ({
		_id: d._id,
		robotId: d.robotId,
		robotName: d.robotName,
		positionSetId: d.positionSetId,
		positionSetTitle: d.positionSetTitle,
		status: d.status,
		slotsTotal: d.slotsTotal,
		slotsDone: d.slotsDone,
		scanCount: (d.scans ?? []).length,
		errorCount: (d.errors ?? []).length,
		source: d.source,
		contextRef: d.contextRef,
		startedAt: d.startedAt,
		completedAt: d.completedAt,
		requestedByUsername: d.requestedByUsername,
		abortReason: d.abortReason
	}));

	return json({ items });
};
