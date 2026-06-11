/**
 * Robot deck-barcode scan (OT2-BRIDGE-2).
 * POST /api/scanner/deck-scan  { robotId: string }
 *
 * A 1-position sweep: enqueues a kind:'deck_scan' Ot2BridgeCommand using the
 * taught deckBarcodePosition on the robot's default position set; the
 * ot2-bridge daemon opens a maintenance run, moves the gantry scanner over
 * the deck's barcode label, scans it, and posts the barcode back as the
 * command result. Unlike the sweep, this endpoint waits synchronously
 * (~10-15s end-to-end) and responds { success: true, barcode }.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB,
	OpentronsRobot,
	OpentronsScannerPositionSet,
	Ot2BridgeCommand,
	AuditLog,
	generateId
} from '$lib/server/db';
import { getRobot, bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';

export const config = { maxDuration: 60 };

const POLL_INTERVAL_MS = 250;
const WAIT_TIMEOUT_MS = 45_000;
const COMMAND_TTL_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	const user = locals.user;

	const body = await request.json().catch(() => ({} as any));
	const robotId = body?.robotId?.toString().trim();
	if (!robotId) error(400, 'robotId required');

	// Same robot resolution as /api/scanner/sweep — the deck-loading grids
	// pass the identical robotId prop, which may be a legacy Equipment id.
	let robot = await getRobot(robotId);
	if (!robot) {
		await connectDB();
		robot = (await OpentronsRobot.findOne({ legacyRobotId: robotId, isActive: { $ne: false } }).lean()) as any;
	}
	if (!robot) error(404, 'Robot not found');

	await connectDB();
	const set: any = await OpentronsScannerPositionSet.findOne({
		robotId: robot._id,
		isDefault: true
	}).lean();

	const pos = set?.deckBarcodePosition;
	if (
		!set ||
		typeof pos?.x !== 'number' ||
		typeof pos?.y !== 'number' ||
		typeof pos?.z !== 'number'
	) {
		error(400, 'No deck-barcode position taught for this robot — teach it on the scanner-positions page');
	}

	const deviceId = bridgeDeviceIdForRobot(robot);
	const cmd = await Ot2BridgeCommand.create({
		_id: generateId(),
		robotId: String(robot._id),
		deviceId,
		kind: 'deck_scan',
		payload: {
			position: { x: pos.x, y: pos.y, z: pos.z },
			pipetteMount: set.pipetteMount ?? 'left',
			pipetteName: set.pipetteName ?? null,
			scanTimeoutS: 3
		},
		ttlMs: COMMAND_TTL_MS,
		requestedBy: user.username
	});

	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const doc = (await Ot2BridgeCommand.findById(cmd._id)
			.select('status result error')
			.lean()) as any;

		if (doc?.status === 'completed') {
			const barcode = doc.result?.body?.barcode;
			if (typeof barcode !== 'string' || !barcode) {
				error(502, 'Bridge daemon completed the deck scan but returned no barcode');
			}
			await AuditLog.create({
				_id: generateId(),
				tableName: 'ot2_bridge_commands',
				recordId: cmd._id,
				action: 'deck_scan',
				newData: {
					robotId: String(robot._id),
					deviceId,
					positionSetId: set._id,
					barcode
				},
				changedAt: new Date(),
				changedBy: user.username
			});
			return json({ success: true, barcode });
		}
		if (doc?.status === 'failed' || doc?.status === 'expired') {
			error(502, doc.error || `Deck scan ${doc.status}`);
		}
		await sleep(POLL_INTERVAL_MS);
	}

	// Timed out waiting — expire the command so the queue doesn't hold a
	// stale deck_scan for a dead daemon to pick up later.
	await Ot2BridgeCommand.updateOne(
		{ _id: cmd._id, status: { $in: ['pending', 'claimed'] } },
		{
			$set: {
				status: 'expired',
				error: 'BIMS gave up waiting for the bridge daemon',
				completedAt: new Date()
			}
		}
	).catch(() => {});
	error(504, "bridge daemon did not respond — is the robot's bridge online?");
};
