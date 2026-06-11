/**
 * Scanner sweep — production "Scan Cartridges" flow (OT2-BRIDGE-2).
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
 * Returns IMMEDIATELY with the sweepRunId. The sweep itself executes ON the
 * robot: this route enqueues a single kind:'sweep' Ot2BridgeCommand and the
 * ot2-bridge daemon (which owns the scanner serial port) claims it, opens a
 * maintenance run locally, walks every taught position, and scans each slot
 * directly. After each slot the daemon POSTs
 * /api/agent/ot2/commands/<id>/progress, which mirrors the result onto the
 * OpentronsScannerSweepRun doc and echoes pauseRequested/cancelRequested —
 * so the existing client flow (poll GET /api/scanner/sweep/<id>, POST
 * cancel/pause/resume) keeps working unchanged.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB,
	OpentronsRobot,
	OpentronsScannerPositionSet,
	OpentronsScannerSweepRun,
	Ot2BridgeCommand,
	AuditLog,
	generateId
} from '$lib/server/db';
import { getRobot, bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';

const VALID_SOURCES = new Set(['wax_filling', 'reagent_filling', 'manual', 'test']);
// The daemon must claim the sweep command within this window; after that the
// poll endpoint expires it and the sweep is considered dead on arrival.
const SWEEP_COMMAND_TTL_MS = 120_000;

// Scanner deviceId convention: ot2-<slot>-scanner, where slot is the trailing
// R/B + two digits in the OpentronsRobot.name field ("Robot 3 B07" → b07).
// Kept on the SweepRun doc for continuity with pre-bridge sweep history.
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

	// Enqueue ONE bridge command — the daemon executes the whole walk locally
	// and streams per-slot progress back. slotIndex order is the walk order.
	const bridgeDeviceId = bridgeDeviceIdForRobot(robot);
	const walkedPositions = Array.from({ length: slotsToWalk }, (_, slotIndex) => {
		const p = positionsBySlot.get(slotIndex)!;
		return { slotIndex, x: p.x, y: p.y, z: p.z };
	});

	let command: any;
	try {
		command = await Ot2BridgeCommand.create({
			_id: generateId(),
			robotId: opentronsRobotId,
			deviceId: bridgeDeviceId,
			kind: 'sweep',
			payload: {
				sweepRunId: sweepRun._id,
				positions: walkedPositions,
				pipetteMount: set.pipetteMount ?? 'left',
				pipetteName: set.pipetteName ?? null,
				scanTimeoutS: 3,
				retryOnce: true
			},
			ttlMs: SWEEP_COMMAND_TTL_MS,
			requestedBy: user.username
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		await OpentronsScannerSweepRun.findByIdAndUpdate(sweepRun._id, {
			$set: { status: 'errored', completedAt: new Date(), abortReason: `Failed to enqueue bridge command: ${msg}` },
			$push: {
				log: { ts: new Date(), level: 'error', message: `Failed to enqueue bridge command: ${msg}` }
			}
		}).catch(() => {});
		error(500, `Failed to enqueue sweep command: ${msg}`);
	}

	await OpentronsScannerSweepRun.findByIdAndUpdate(sweepRun._id, {
		$push: {
			log: {
				ts: new Date(),
				level: 'info',
				message: `Sweep queued for bridge daemon ${bridgeDeviceId} (command ${command._id}).`
			}
		}
	});

	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_scanner_sweeps',
		recordId: set._id,
		action: 'sweep_enqueued',
		newData: {
			sweepRunId: sweepRun._id,
			robotId: opentronsRobotId,
			positionSetId: set._id,
			deviceId,
			bridgeDeviceId,
			commandId: command._id,
			source,
			contextRef,
			slotsWalked: slotsToWalk
		},
		changedAt: new Date(),
		changedBy: user.username
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
