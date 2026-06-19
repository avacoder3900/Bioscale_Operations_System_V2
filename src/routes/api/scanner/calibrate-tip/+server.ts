/**
 * Robot-side tip calibration (NATIVE-CALIBRATION-SYSTEM PRD 4).
 * POST /api/scanner/calibrate-tip  { robotId: string, mount?: 'left' | 'right' }
 *
 * Enqueues a kind:'calibrate_tip' Ot2BridgeCommand. The ot2-bridge daemon picks
 * up a tip, touches it against the calibrator's limit switches over serial
 * (replicating the protocols' pick_up_and_calibrate_tip), and posts back the
 * per-tip adjust{x,y} — how far the bent tip is off nominal. BIMS stores that
 * for the jog session and applies it to subsequent move-to so tuning is done
 * against a tip-zeroed reference (else captured geometry double-counts the bend).
 *
 * mount → tip type: right = p20 (wax, 20µL rack, zCalWax); left = p300 (reagent,
 * Biotix 200µL rack, zCalReagent) — same mapping as the studio's tiprackForMount.
 *
 * ROBOT-VALIDATION-GATED: the serial-probe motion + the carriage-frame math in
 * the daemon are carried verbatim from the .py and need a live robot + the
 * calibrator fixture on the wire to verify. Synchronous wait (~probe is ~1-2min).
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB,
	OpentronsRobot,
	LabwareDefinition,
	TipCalibratorFixture,
	Ot2BridgeCommand,
	AuditLog,
	generateId
} from '$lib/server/db';
import { getRobot, bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';

export const config = { maxDuration: 300 };

const POLL_INTERVAL_MS = 500;
const WAIT_TIMEOUT_MS = 240_000;
const COMMAND_TTL_MS = 270_000;

// mount → (tiprack loadName, default z_cal). Matches the studio + the protocols.
const TIP_FOR_MOUNT: Record<string, { loadName: string; zCalKey: 'zCalWax' | 'zCalReagent'; defaultZ: number }> = {
	right: { loadName: 'cosmasanddamian_96_tiprack_20ul', zCalKey: 'zCalWax', defaultZ: 34.491 },
	left: { loadName: 'cosmas_and_damian_biotix_96_200ul_tiprack', zCalKey: 'zCalReagent', defaultZ: 40.8 }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	const user = locals.user;

	const body = await request.json().catch(() => ({}) as any);
	const robotId = body?.robotId?.toString().trim();
	const mount = (body?.mount?.toString().trim() === 'right' ? 'right' : 'left') as 'left' | 'right';
	const tipWell = body?.tipWell?.toString().trim() || 'A1';
	// ATTACHED mode: probe inside the studio's open maintenance run (tip already
	// picked up there) so the tip + run survive for deck tuning. Both required.
	const studioRunId = body?.runId?.toString().trim() || null;
	const studioPipetteId = body?.pipetteId?.toString().trim() || null;
	if (!robotId) error(400, 'robotId required');

	let robot = await getRobot(robotId);
	if (!robot) {
		await connectDB();
		robot = (await OpentronsRobot.findOne({ legacyRobotId: robotId, isActive: { $ne: false } }).lean()) as any;
	}
	if (!robot) error(404, 'Robot not found');

	await connectDB();

	const tipSpec = TIP_FOR_MOUNT[mount];
	const tipDef = (await LabwareDefinition.findOne({ loadName: tipSpec.loadName }).lean()) as any;
	if (!tipDef?.definition) {
		error(400, `Tiprack '${tipSpec.loadName}' not in the BIMS labware library`);
	}

	// Calibrator point: per-robot fixture, else the 'global' fallback, else .py default.
	const fixture =
		((await TipCalibratorFixture.findOne({ robotId: String(robot._id) }).lean()) as any) ||
		((await TipCalibratorFixture.findOne({ robotId: 'global' }).lean()) as any);
	const calX = Number(fixture?.position?.x ?? 125.181);
	const calY = Number(fixture?.position?.y ?? 173.247);
	const zCal = Number(fixture?.[tipSpec.zCalKey] ?? tipSpec.defaultZ);

	const deviceId = bridgeDeviceIdForRobot(robot);
	const cmd = await Ot2BridgeCommand.create({
		_id: generateId(),
		robotId: String(robot._id),
		deviceId,
		kind: 'calibrate_tip',
		payload: {
			pipetteMount: mount,
			calibrator: { x: calX, y: calY, z: zCal },
			tiprack: {
				definition: tipDef.definition,
				namespace: tipDef.namespace ?? '',
				loadName: tipSpec.loadName,
				version: tipDef.version ?? 1,
				slot: '11',
				tipWell
			},
			// Present → daemon probes inside this run and keeps the tip on.
			...(studioRunId && studioPipetteId ? { runId: studioRunId, pipetteId: studioPipetteId } : {})
		},
		ttlMs: COMMAND_TTL_MS,
		requestedBy: user.username
	});

	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const doc = (await Ot2BridgeCommand.findById(cmd._id).select('status result error').lean()) as any;

		if (doc?.status === 'completed') {
			const adjust = doc.result?.body?.adjust;
			if (!adjust || typeof adjust.x !== 'number' || typeof adjust.y !== 'number') {
				error(502, 'Bridge completed the tip calibration but returned no adjust');
			}
			await AuditLog.create({
				_id: generateId(),
				tableName: 'ot2_bridge_commands',
				recordId: cmd._id,
				action: 'calibrate_tip',
				newData: { robotId: String(robot._id), deviceId, mount, adjust, result: doc.result?.body },
				changedAt: new Date(),
				changedBy: user.username
			});
			return json({ success: true, adjust, result: doc.result?.body });
		}
		if (doc?.status === 'failed' || doc?.status === 'expired') {
			error(502, doc.error || `Tip calibration ${doc.status}`);
		}
		await sleep(POLL_INTERVAL_MS);
	}

	await Ot2BridgeCommand.updateOne(
		{ _id: cmd._id, status: { $in: ['pending', 'claimed'] } },
		{ $set: { status: 'expired', error: 'BIMS gave up waiting for the bridge daemon', completedAt: new Date() } }
	).catch(() => {});
	error(504, "bridge daemon did not respond — is the robot's bridge online?");
};
