/**
 * Robot-side tip calibration (NATIVE-CALIBRATION-SYSTEM PRD 4).
 * POST /api/scanner/calibrate-tip
 *   { robotId, mount?, tipWell?, runId?, pipetteId?,
 *     calibrator?: { x?, y?, z? } }   ← probe HERE instead of the saved point
 *
 * Enqueues a kind:'calibrate_tip' Ot2BridgeCommand. The ot2-bridge daemon picks
 * up a tip, touches it against the calibrator's limit switches over serial
 * (replicating the protocols' pick_up_and_calibrate_tip), and posts back the
 * per-tip adjust{x,y} — how far the bent tip is off nominal. BIMS stores that
 * for the jog session and applies it to subsequent move-to so tuning is done
 * against a tip-zeroed reference (else captured geometry double-counts the bend).
 *
 * mount → tip type and the calibrator point both come from
 * $lib/server/services/deck-calibration/tip-calibrator (single source of truth).
 *
 * TEACH FLOW: the deck-calibration wizard jogs the tip onto the fixture and then
 * sends that live position as `calibrator`, so the probe runs AT the jogged
 * point rather than at whatever was saved last time. Nothing is persisted here —
 * on success the page calls its own `saveCalibrator` action with the result.
 *
 * ROBOT-VALIDATION-GATED: the serial-probe motion + the carriage-frame math in
 * the daemon are carried verbatim from the .py and need a live robot + the
 * calibrator fixture on the wire to verify. `probed` is only ever a real reading
 * from the robot (null otherwise) — never a default or an echo of what we asked
 * for. Synchronous wait (~probe is ~1-2min); a bridge that never answers comes
 * back as { success: false, probed: null, error } rather than an HTTP throw, so
 * the wizard can show the operator what happened instead of a red 504.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB,
	OpentronsRobot,
	LabwareDefinition,
	Ot2BridgeCommand,
	AuditLog,
	generateId
} from '$lib/server/db';
import { getRobot, bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';
import {
	TIP_PROFILE,
	asTipProfile,
	resolveCalibratorPoint,
	applyCalibratorOverride,
	readProbeResult,
	type CalMount,
	type CalPoint,
	type CalSource
} from '$lib/server/services/deck-calibration/tip-calibrator';

export const config = { maxDuration: 300 };

const POLL_INTERVAL_MS = 500;
const WAIT_TIMEOUT_MS = 240_000;
const COMMAND_TTL_MS = 270_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shape returned on every non-guard outcome, so the wizard can render one way. */
type ProbeResponse = {
	success: boolean;
	error?: string;
	probed: CalPoint | null;
	probedSource: string | null;
	adjust: { x: number; y: number } | null;
	/** Exactly where we told the robot to probe, and where that point came from. */
	calibrator: CalPoint;
	calibratorSource: CalSource;
	result?: unknown;
};

/**
 * A probe that never produced a reading. Not an HTTP error: the request was
 * valid, the robot just didn't answer — the operator needs the message, not a
 * stack trace. probed stays null; we never fill it in with the commanded point.
 */
const noReading = (
	message: string,
	calibrator: CalPoint,
	calibratorSource: CalSource
): ProbeResponse => ({
	success: false,
	error: message,
	probed: null,
	probedSource: null,
	adjust: null,
	calibrator,
	calibratorSource
});

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	const user = locals.user;

	const body = await request.json().catch(() => ({}) as any);
	const robotId = body?.robotId?.toString().trim();
	// Both of these fail CLOSED. `mount` used to silently fall back to 'left'
	// for any unrecognised value, and the calibration Z used to be derived from
	// it — so a caller that sent nothing got a real probe at a guessed depth.
	const rawMount = body?.mount?.toString().trim();
	if (rawMount !== 'left' && rawMount !== 'right') {
		error(400, "mount must be exactly 'left' or 'right'");
	}
	const mount: CalMount = rawMount;
	// Which tip is on that mount is an operator choice; it is never inferred
	// from the mount, because the pipettes are not fixed to mounts on this fleet.
	const tipProfile = asTipProfile(body?.tipProfile);
	if (!tipProfile) {
		error(400, "tipProfile must be exactly 'wax' (p20) or 'reagent' (p300)");
	}
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

	const tipSpec = TIP_PROFILE[tipProfile];
	const tipDef = (await LabwareDefinition.findOne({ loadName: tipSpec.loadName }).lean()) as any;
	if (!tipDef?.definition) {
		error(400, `Tiprack '${tipSpec.loadName}' not in the BIMS labware library`);
	}

	// Calibrator point: per-robot fixture → 'global' fallback → .py default …
	const saved = await resolveCalibratorPoint(String(robot._id), tipProfile);
	// … then the operator's jogged point wins, axis by axis, when they sent one.
	const { point: calibrator, overridden } = applyCalibratorOverride(saved.point, body?.calibrator);
	const calibratorSource: CalSource = overridden ? 'jogged' : saved.source;
	const { x: calX, y: calY, z: zCal } = calibrator;

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
			const resultBody = doc.result?.body;
			// The reading, straight from the robot. Null when it sent nothing usable.
			const { probed, probedSource, adjust } = readProbeResult(resultBody, calibrator);
			if (!adjust) {
				return json(
					noReading(
						'The robot finished the probe but reported no measurement — nothing was taught. Check the calibrator wiring and try again.',
						calibrator,
						calibratorSource
					)
				);
			}
			await AuditLog.create({
				_id: generateId(),
				tableName: 'ot2_bridge_commands',
				recordId: cmd._id,
				action: 'calibrate_tip',
				newData: {
					robotId: String(robot._id),
					deviceId,
					mount,
					calibrator,
					calibratorSource,
					adjust,
					probed,
					probedSource,
					result: resultBody
				},
				changedAt: new Date(),
				changedBy: user.username
			});
			// No fixture write here — the page persists the taught point via
			// its saveCalibrator action once the operator accepts this reading.
			const ok: ProbeResponse = {
				success: true,
				probed,
				probedSource,
				adjust,
				calibrator,
				calibratorSource,
				result: resultBody
			};
			return json(ok);
		}
		if (doc?.status === 'failed' || doc?.status === 'expired') {
			return json(
				noReading(
					doc.error || `Tip calibration ${doc.status} on the robot — nothing was taught.`,
					calibrator,
					calibratorSource
				)
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}

	await Ot2BridgeCommand.updateOne(
		{ _id: cmd._id, status: { $in: ['pending', 'claimed'] } },
		{ $set: { status: 'expired', error: 'BIMS gave up waiting for the bridge daemon', completedAt: new Date() } }
	).catch(() => {});
	return json(
		noReading(
			"The robot's bridge did not respond within " +
				Math.round(WAIT_TIMEOUT_MS / 1000) +
				"s — is the bridge daemon online? Nothing was taught.",
			calibrator,
			calibratorSource
		)
	);
};
