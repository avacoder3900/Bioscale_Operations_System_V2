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
 *
 * TAILNET LINE (OT2-TAILNET-5 S6, opt-in via body `line: 'tailnet'`):
 *   phase 'prepare' (default) → same guards, no queue write; returns
 *     { success, line, job: { jobId, kind: 'deck_scan', payload } } for the
 *     browser to POST to the robot daemon's /bridge/jobs.
 *   phase 'confirm' + { jobId, status, result, error } (the /bridge job
 *     snapshot) → the same completion half as the queue line: deck QR alias →
 *     canonical deck id, AuditLog 'deck_scan' (stamped line:'tailnet'), and the
 *     same { success: true, barcode } / 502 answers.
 *   409 when the robot is not on the tailnet line here (two-key gate), or this deployment has no OT2_BRIDGE_TOKEN_SECRET (bridgeJobGate).
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
	Equipment,
	generateId
} from '$lib/server/db';
import { getRobot, bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';
import { bridgeJobGate, isTailnetLineRequest } from '$lib/server/opentrons/bridge-token';

export const config = { maxDuration: 60 };

const POLL_INTERVAL_MS = 250;
const WAIT_TIMEOUT_MS = 45_000;
const COMMAND_TTL_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const JOB_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * The completion half, shared by both lines: the gantry reads the deck QR
 * alias; translate it to the deck's canonical id (e.g. DECK-004) so downstream
 * uses the linear identity, and audit the scan.
 */
async function recordDeckScan(
	barcode: string,
	audit: { tableName: string; recordId: string; newData: Record<string, unknown>; username: string }
): Promise<string> {
	const matchedDeck = (await Equipment.findOne({
		equipmentType: 'deck',
		$or: [{ _id: barcode }, { qrCode: barcode }]
	}).select('_id').lean()) as any;
	const resolved = matchedDeck?._id ? String(matchedDeck._id) : barcode;
	await AuditLog.create({
		_id: generateId(),
		tableName: audit.tableName,
		recordId: audit.recordId,
		action: 'deck_scan',
		newData: { ...audit.newData, barcode, resolved },
		changedAt: new Date(),
		changedBy: audit.username
	});
	return resolved;
}

export const POST: RequestHandler = async ({ request, locals, url }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	const user = locals.user;

	const body = await request.json().catch(() => ({} as any));
	const tailnet = isTailnetLineRequest(body, url);
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
	if (tailnet) {
		const gate = bridgeJobGate(robot);
		if (!gate.ok) error(409, gate.reason);
	}

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
	const deckScanPayload = {
		position: { x: pos.x, y: pos.y, z: pos.z },
		pipetteMount: set.pipetteMount ?? 'left',
		pipetteName: set.pipetteName ?? null,
		scanTimeoutS: 3
	};

	if (tailnet) {
		if (body?.phase !== 'confirm') {
			return json({
				success: true,
				line: 'tailnet',
				job: { jobId: generateId(), kind: 'deck_scan', payload: deckScanPayload }
			});
		}
		const jobId = body?.jobId?.toString() ?? '';
		if (!JOB_ID_RE.test(jobId)) error(400, 'jobId required to confirm a tailnet deck scan');
		if (body?.status !== 'completed') {
			error(502, (typeof body?.error === 'string' && body.error) || `Deck scan ${body?.status ?? 'failed'}`);
		}
		const barcode = body?.result?.barcode;
		if (typeof barcode !== 'string' || !barcode) {
			error(502, 'Bridge daemon completed the deck scan but returned no barcode');
		}
		const resolved = await recordDeckScan(barcode, {
			tableName: 'ot2_bridge_jobs',
			recordId: jobId,
			newData: {
				robotId: String(robot._id),
				deviceId,
				positionSetId: set._id,
				bridgeJobId: jobId,
				line: 'tailnet'
			},
			username: user.username
		});
		return json({ success: true, barcode: resolved });
	}

	const cmd = await Ot2BridgeCommand.create({
		_id: generateId(),
		robotId: String(robot._id),
		deviceId,
		kind: 'deck_scan',
		payload: deckScanPayload,
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
			const resolved = await recordDeckScan(barcode, {
				tableName: 'ot2_bridge_commands',
				recordId: cmd._id,
				newData: {
					robotId: String(robot._id),
					deviceId,
					positionSetId: set._id
				},
				username: user.username
			});
			return json({ success: true, barcode: resolved });
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
