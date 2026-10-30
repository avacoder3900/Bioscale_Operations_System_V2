/**
 * Robot-arm wax fill line (/manufacturing/cart-mfg/robot-arm/wax-fill).
 *
 * One cart at a time: the OT-2 gantry is homed, the arm plays its GRAB
 * animation (an Animate move set or sequence) to put a cart on the arm's
 * single-cart stage, the gantry scanner reads the cart at the taught scan
 * position (a one-slot scanner sweep), the OT-2 runs its wax-filling protocol
 * on that one cart, the gantry is homed again and the arm plays its WITHDRAW
 * animation. The browser drives each
 * step through the page's actions (the same pattern as the Animate verified
 * run and the two-phase OT-2 start), so every step's ids are on the
 * ArmWaxFillRun before the next one starts and a reload resumes the cycle.
 *
 * Reused as-is: Animate playback (playMoveSet / playSequence, afterPlay),
 * the production scanner sweep (/api/scanner/sweep, called by the browser),
 * and the wax run lifecycle (startRunQueue → the robot's current wax-filling
 * protocol with the freshness gate; recordRunFinishedQueue → the cart goes
 * wax_filled and the WaxFillingRun completes, releasing the robot).
 *
 * The animations are chosen once and kept (ArmWaxFillSettings); the page
 * only re-asks after an explicit "Change animations". Calibration is per
 * OT-2 (ArmWaxFillCalibration): the scan position is mirrored into a
 * one-slot OpentronsScannerPositionSet so the sweep code reads it unchanged;
 * the cart location — the rim of the cart's first wax hole, taught
 * TIP-NEUTRAL (live minus the teaching tip's calibrator probe) — is sent to
 * the stage protocol (protocols/Wax_Filling_GEN7_ArmStage.py) as
 * arm_cart_x/y/z plus the stage's cart rotation. A robot still running the
 * 24-slot carriage protocol (no arm_cart_* in its schema) falls back to the
 * legacy deck-position stopgap.
 *
 * ARM-WAX-LOOP-B (2026-10-29, docs/prds/ARM-WAX-LOOP-B-ONE-RUN-PER-LOOP.md):
 * ONE OT-2 run serves the whole loop and ONE tip serves every cart of it. The
 * protocol homes, takes its tip, probes it once, aspirates, parks the tip IN
 * the wax tube (the wax stays warm) and pauses `ARM PARKED 1`. Per cart BIMS
 * resumes it with an instruction the bridge daemon writes to /data/arm_loop.json
 * (scan → the gantry goes to the taught scan position and pauses `ARM AT_SCAN
 * <i>`, the daemon reads the scanner over serial; fill → the 12 holes, back to
 * the tube, re-aspirate, park, `ARM PARKED <i+1>`; skip → back to the tube and
 * park; end → tip to the trash, home, the run ends).
 *
 * Collision rule (Alejandro, 2026-10-29): the OT-2 and the arm may move at the
 * same time as long as the OT-2 is not at the calibrator and not over the
 * stage. So the arm plays (grab, withdraw, the fail animation) only while the
 * run is paused `ARM PARKED <i>` — the robot itself reports it (assertRunParked)
 * — and never at AT_SCAN; the run leaves the tube only on a BIMS resume, sent
 * after the arm's play has settled. The last cart's `end` goes out before its
 * withdraw, so the tip-to-trash and the home overlap the arm. The OT-2 pipette
 * still goes ALL THE WAY UP before every move that leaves the tube or the
 * stage (the lift rule, in the protocol and the Stage Calibration Studio).
 *
 * Later: the cart-drop unit that dispenses carts for the arm will slot in
 * before the grab step; nothing here assumes where the arm picks a cart up.
 */
import {
	connectDB,
	generateId,
	ArmWaxFillCalibration,
	ArmWaxFillRun,
	ArmWaxFillSettings,
	AuditLog,
	BucketCycle,
	CartridgeRecord,
	OpentronProtocol,
	OpentronsRobot,
	OpentronsScannerPositionSet,
	OpentronsScannerSweepRun,
	Ot2BridgeCommand,
	TipCalibratorFixture,
	WaxFillingRun
} from '$lib/server/db';
import crypto from 'node:crypto';
import { checkRobotConflict } from '$lib/server/manufacturing/resource-locks';
import { getRobotsHealth, type RobotHealth } from '$lib/server/opentrons/health';
import { consumeCarts, findBucketLabels, BucketError } from '$lib/server/services/bucket-service';
import { currentProtocolEntry, recordResyncUpload } from '$lib/server/opentrons/protocol-freshness';
import { assembleProtocolUpload, bridgeDeviceIdForRobot, getRobot, robotDelete, robotGet, robotPost, uploadAssembledProtocol } from '$lib/server/opentrons/proxy';
import { ARM_LOOP_INSTRUCTION_PATH, isParkedFor, parseArmPause, type ArmLoopAction, type ArmLoopInstruction, type ArmPause, armMayMove, parseArmComment, type ArmMarker, type ArmMoveWant } from '$lib/robot-arm/arm-loop-protocol';
import { nextStudioTipWell } from '$lib/server/opentrons/tip-cursor';
import { TIP_PROFILE, asTipProfile, plausibleZ, resolveCalibratorPoint, type TipProfile } from '$lib/server/services/deck-calibration/tip-calibrator';
import {
	DISPENSE_DEPTH_LIMITS,
	CART_LOCATION_LIMITS,
	HOLE_OFFSET_LIMIT_MM,
	STAGE_ROTATION_DEFAULT_DEG,
	STAGE_WELL_NAMES,
	WAX_HOLE_DEPTH_MM,
	depthFromLive,
	holeOffsetParamNames,
	stageTargets,
	type HoleOffsets,
	type StageHole
} from '$lib/robot-arm/stage-geometry';
import { CAL_Z_LIMITS } from '$lib/server/services/deck-calibration/tip-calibrator';
import {
	isActionFail,
	recordRunFinishedQueue,
	startRunQueue,
	stopRunQueue
} from '$lib/server/opentrons/run-lifecycle-records';
import {
	AnimateError,
	getMoveSet,
	getSequence,
	listMoveSets,
	listSequences,
	playMoveSet,
	playSequence,
	playbackActive,
	stopPlayback,
	type PlayResult
} from '$lib/server/robot-arm-animation';

type User = { _id: string; username: string };

export class ArmWaxFillError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

/** Title of the one-slot scanner position set this line keeps per robot. */
export const SCAN_SET_TITLE = 'Arm wax fill — single cart';
/** Protocol run-time parameters the cart location is sent as, when declared. */
export const CART_LOCATION_RTPS = ['arm_cart_x', 'arm_cart_y', 'arm_cart_z'] as const;
/**
 * Declared only by protocols/Wax_Filling_GEN7_ArmStage_Rehearsal_p300.py — the
 * stage fill walked on the p300 with 200 µL tips and AIR. A robot carrying it
 * rehearses the loop; it never fills a cart.
 */
export const REHEARSAL_RTP = 'z_cal_p300';
/** A stored .py that declares the taught-cart RTPs (a stage protocol) / the rehearsal's own RTP. */
const STAGE_MARKER = `variable_name="${CART_LOCATION_RTPS[0]}"`;
const REHEARSAL_MARKER = `variable_name="${REHEARSAL_RTP}"`;

/**
 * The FAIL ROUTE. A step listed here that fails does not end the loop where it
 * stands: the cycle goes to step 'fail' (failedStep = the step, error = why),
 * the OT-2 gantry is homed, the arm plays the FAIL animation (chosen on the
 * Animations card like grab and withdraw; it may be the withdraw animation)
 * and only then does the loop end as failed. Today only the scan takes it:
 * the scanner read nothing (sweep errored, timed out or completed without a
 * barcode), or it read a barcode but the cart is not in the right state to be
 * filled (not a backed cart, a bucket label, unknown outside test mode). A
 * failure of the fail route itself (home refused, play refused) ends the loop
 * the plain way, with the cart still on the stage. More fail modes add their
 * step here and call enterFailRoute.
 */
export const FAIL_ROUTE_STEPS = ['scan', 'decide'] as const;
export type FailRouteStep = (typeof FAIL_ROUTE_STEPS)[number];

export type AnimationKind = 'move_set' | 'sequence';
export interface AnimationRef {
	kind: AnimationKind;
	id: string;
	name: string | null;
}

const opRef = (u: User) => ({ _id: u._id, username: u.username });

async function audit(user: User, action: string, tableName: string, recordId: string, newData: Record<string, unknown>) {
	await AuditLog.create({
		_id: generateId(),
		tableName,
		recordId,
		action,
		newData: { ...newData, userId: user._id },
		changedAt: new Date(),
		changedBy: user.username
	});
}

/** Scanner deviceId convention shared with the scanner pages: ot2-<slot>-scanner. */
export function scannerDeviceIdForRobot(robotName: string | undefined | null): string {
	const match = (robotName ?? '').match(/\b([A-Z]\d{2})\b/);
	const slot = match?.[1]?.toLowerCase();
	return slot ? `ot2-${slot}-scanner` : 'unknown-scanner';
}

function num(v: unknown, what: string): number {
	const n = Number(v);
	if (!Number.isFinite(n)) throw new ArmWaxFillError(`${what} must be a number.`);
	return n;
}

/** "move_set:<id>" | "sequence:<id>" → the ref, with the record's current name. */
async function resolveAnimation(raw: unknown, what: string): Promise<AnimationRef> {
	const s = String(raw ?? '').trim();
	const i = s.indexOf(':');
	const kind = s.slice(0, i);
	const id = s.slice(i + 1);
	if ((kind !== 'move_set' && kind !== 'sequence') || !id) throw new ArmWaxFillError(`Pick a ${what} animation.`);
	const rec = kind === 'move_set' ? await getMoveSet(id) : await getSequence(id);
	if (!rec) throw new ArmWaxFillError(`The ${what} animation no longer exists — reload the page.`, 404);
	if (rec.archived) throw new ArmWaxFillError(`"${rec.name}" is archived — restore it in Animate or pick another ${what} animation.`);
	return { kind, id, name: rec.name };
}

// ── settings ─────────────────────────────────────────────────────────────

export interface SettingsView {
	robotId: string | null;
	cartPosition: number;
	waxSourceLot: string | null;
	testMode: boolean;
	grabAnimation: AnimationRef | null;
	withdrawAnimation: AnimationRef | null;
	failAnimation: AnimationRef | null;
	animationsChangedAt: string | null;
	animationsChangedBy: string | null;
}

function animRef(d: any): AnimationRef | null {
	return d?.kind && d?.id ? { kind: d.kind, id: String(d.id), name: d.name ?? null } : null;
}

function settingsView(d: any): SettingsView {
	return {
		robotId: d?.robotId ?? null,
		cartPosition: Number(d?.cartPosition) || 1,
		waxSourceLot: d?.waxSourceLot ?? null,
		testMode: !!d?.testMode,
		grabAnimation: animRef(d?.grabAnimation),
		withdrawAnimation: animRef(d?.withdrawAnimation),
		failAnimation: animRef(d?.failAnimation),
		animationsChangedAt: d?.animationsChangedAt ? new Date(d.animationsChangedAt).toISOString() : null,
		animationsChangedBy: d?.animationsChangedBy?.username ?? null
	};
}

export async function getSettings(): Promise<SettingsView> {
	await connectDB();
	return settingsView(await ArmWaxFillSettings.findById('default').lean());
}

export async function saveSetup(
	user: User,
	input: { robotId: unknown; cartPosition: unknown; waxSourceLot: unknown; testMode: boolean }
): Promise<SettingsView> {
	await connectDB();
	const robotId = String(input.robotId ?? '').trim();
	if (!robotId) throw new ArmWaxFillError('Pick the OT-2 the arm feeds.');
	const robot = (await OpentronsRobot.findById(robotId).select('_id name isActive').lean()) as any;
	if (!robot || robot.isActive === false) throw new ArmWaxFillError('That robot is not active.', 404);
	const cartPosition = input.cartPosition === null || input.cartPosition === undefined || String(input.cartPosition).trim() === '' ? 1 : Math.round(num(input.cartPosition, 'Cart position'));
	if (cartPosition < 1 || cartPosition > 24) throw new ArmWaxFillError('Cart position must be 1–24.');
	const waxSourceLot = String(input.waxSourceLot ?? '').trim().slice(0, 100) || null;
	const before = settingsView(await ArmWaxFillSettings.findById('default').lean());
	await ArmWaxFillSettings.updateOne(
		{ _id: 'default' },
		{ $set: { robotId, cartPosition, waxSourceLot, testMode: !!input.testMode, updatedBy: opRef(user) } },
		{ upsert: true }
	);
	await audit(user, 'arm_wax_fill.setup', 'arm_wax_fill_settings', 'default', {
		robotId,
		robotName: robot.name,
		cartPosition,
		waxSourceLot,
		testMode: !!input.testMode,
		before: { robotId: before.robotId, cartPosition: before.cartPosition, waxSourceLot: before.waxSourceLot, testMode: before.testMode }
	});
	return settingsView(await ArmWaxFillSettings.findById('default').lean());
}

/** Only called after the operator explicitly chose to change them. */
export async function saveAnimations(user: User, input: { grab: unknown; withdraw: unknown; fail: unknown }): Promise<SettingsView> {
	await connectDB();
	const grab = await resolveAnimation(input.grab, 'grab');
	const withdraw = await resolveAnimation(input.withdraw, 'withdraw');
	// The fail animation may be any animation, the withdraw one included.
	const failAnim = await resolveAnimation(input.fail, 'fail');
	const before = settingsView(await ArmWaxFillSettings.findById('default').lean());
	const now = new Date();
	await ArmWaxFillSettings.updateOne(
		{ _id: 'default' },
		{ $set: { grabAnimation: grab, withdrawAnimation: withdraw, failAnimation: failAnim, animationsChangedAt: now, animationsChangedBy: opRef(user), updatedBy: opRef(user) } },
		{ upsert: true }
	);
	await audit(user, 'arm_wax_fill.animations', 'arm_wax_fill_settings', 'default', {
		grab,
		withdraw,
		fail: failAnim,
		before: { grab: before.grabAnimation, withdraw: before.withdrawAnimation, fail: before.failAnimation }
	});
	return settingsView(await ArmWaxFillSettings.findById('default').lean());
}

// ── calibration ──────────────────────────────────────────────────────────

export interface TaughtPoint {
	x: number;
	y: number;
	z: number;
	taughtAt: string | null;
	taughtBy: string | null;
	testScanBarcode: string | null;
	/**
	 * Cart location only: the calibrator probe adjust of the tip it was taught
	 * with. x/y above are tip-neutral (live − this). Null = taught raw, which the
	 * stage protocol must not be run on (readiness blocks it).
	 */
	tipAdjust: { x: number; y: number } | null;
	tipWell: string | null;
}

export interface DispenseDepthView {
	/** mm below the first hole's rim the tip end dispenses at; negative = hover above it. */
	mm: number;
	liveZ: number | null;
	taughtAt: string | null;
	taughtBy: string | null;
}

export interface CalibrationView {
	robotId: string;
	scanPosition: TaughtPoint | null;
	scanPositionSetId: string | null;
	cartLocation: TaughtPoint | null;
	/** Null = not taught; the stage protocol's default (hover 1 mm above the rim) would apply, so readiness blocks. */
	dispenseDepth: DispenseDepthView | null;
	/** The cart's rotation on the stage, degrees CCW from above about the first hole (arm_cart_rotation_deg). */
	stageRotationDeg: number;
	/** The 12 wax-hole rims laid out from the taught cart location (tip-neutral) plus each hole's correction, or null until it is taught. */
	holes: StageHole[] | null;
	/** Per-hole corrections on the rigid lattice (the Studio's Apply / Set position / Align). */
	holeOffsets: HoleOffsets;
	/** The Studio's "Recent edits", newest first (last 50). */
	edits: StageEditView[];
	pipetteMount: 'left' | 'right';
	pipetteName: string | null;
}

export interface StageEditView {
	_id: string;
	at: string | null;
	by: string | null;
	label: string | null;
	wellName: string;
	delta: { x: number; y: number; z: number };
	after: { x: number; y: number; z: number };
}

function offsetsOf(d: any): HoleOffsets {
	const out: HoleOffsets = {};
	for (const o of (d?.holeOffsets ?? []) as any[]) {
		if (!o?.name || !STAGE_WELL_NAMES.includes(o.name)) continue;
		out[o.name] = { dx: Number(o.dx) || 0, dy: Number(o.dy) || 0, dz: Number(o.dz) || 0 };
	}
	return out;
}

function point(d: any): TaughtPoint | null {
	if (!d || typeof d.x !== 'number' || typeof d.y !== 'number' || typeof d.z !== 'number') return null;
	return {
		x: d.x,
		y: d.y,
		z: d.z,
		taughtAt: d.taughtAt ? new Date(d.taughtAt).toISOString() : null,
		taughtBy: d.taughtBy?.username ?? null,
		testScanBarcode: d.testScanBarcode ?? null,
		tipAdjust: typeof d.tipAdjust?.x === 'number' && typeof d.tipAdjust?.y === 'number' ? { x: d.tipAdjust.x, y: d.tipAdjust.y } : null,
		tipWell: d.tipWell ?? null
	};
}

function calibrationView(robotId: string, d: any): CalibrationView {
	const cartLocation = point(d?.cartLocation);
	const stageRotationDeg = Number.isFinite(Number(d?.stageRotationDeg)) ? Number(d.stageRotationDeg) : STAGE_ROTATION_DEFAULT_DEG;
	const dd = d?.dispenseDepth;
	const holeOffsets = offsetsOf(d);
	const edits: StageEditView[] = ((d?.edits ?? []) as any[])
		.slice(-50)
		.reverse()
		.map((e) => ({
			_id: String(e._id),
			at: iso(e.at),
			by: e.by?.username ?? null,
			label: e.label ?? null,
			wellName: String(e.wellName),
			delta: { x: Number(e.delta?.x) || 0, y: Number(e.delta?.y) || 0, z: Number(e.delta?.z) || 0 },
			after: { x: Number(e.after?.x) || 0, y: Number(e.after?.y) || 0, z: Number(e.after?.z) || 0 }
		}));
	return {
		robotId,
		scanPosition: point(d?.scanPosition),
		scanPositionSetId: d?.scanPositionSetId ?? null,
		cartLocation,
		dispenseDepth:
			typeof dd?.mm === 'number'
				? { mm: dd.mm, liveZ: typeof dd.liveZ === 'number' ? dd.liveZ : null, taughtAt: iso(dd.taughtAt), taughtBy: dd.taughtBy?.username ?? null }
				: null,
		stageRotationDeg,
		holes: cartLocation ? stageTargets(cartLocation.x, cartLocation.y, cartLocation.z, stageRotationDeg, holeOffsets) : null,
		holeOffsets,
		edits,
		pipetteMount: d?.pipetteMount === 'right' ? 'right' : 'left',
		pipetteName: d?.pipetteName ?? null
	};
}

export async function getCalibration(robotId: string | null): Promise<CalibrationView | null> {
	if (!robotId) return null;
	await connectDB();
	return calibrationView(robotId, await ArmWaxFillCalibration.findById(robotId).lean());
}

type PointInput = { x: unknown; y: unknown; z: unknown; pipetteMount?: unknown; pipetteName?: unknown; testScanBarcode?: unknown };

function cleanPoint(input: PointInput) {
	return { x: num(input.x, 'x'), y: num(input.y, 'y'), z: num(input.z, 'z') };
}

function mountOf(input: PointInput, fallback: 'left' | 'right'): 'left' | 'right' {
	return input.pipetteMount === 'right' ? 'right' : input.pipetteMount === 'left' ? 'left' : fallback;
}

/**
 * The one-slot scanner position set this line keeps for the robot: created
 * on the first save, slot 0 overwritten on every later one. Never the
 * robot's default set — production sweeps keep theirs.
 */
async function upsertScanSet(
	user: User,
	robotId: string,
	existingId: string | null,
	p: { x: number; y: number; z: number },
	mount: 'left' | 'right',
	pipetteName: string | null,
	testScanBarcode: string | null
) {
	const now = new Date();
	let set: any = existingId ? await OpentronsScannerPositionSet.findById(existingId).lean() : null;
	if (!set || set.robotId !== robotId) set = await OpentronsScannerPositionSet.findOne({ robotId, title: SCAN_SET_TITLE }).lean();
	const slot = { slotIndex: 0, x: p.x, y: p.y, z: p.z, ...(testScanBarcode ? { testScanBarcode, testScannedAt: now } : {}) };
	if (!set) {
		const _id = generateId();
		await OpentronsScannerPositionSet.create({
			_id,
			robotId,
			title: SCAN_SET_TITLE,
			positionCount: 1,
			positions: [slot],
			isDefault: false,
			pipetteMount: mount,
			pipetteName: pipetteName ?? undefined,
			notes: 'Kept by the robot-arm wax fill page: the scan position of the single cart the arm places. Edit it there.',
			calibratedBy: opRef(user),
			calibratedAt: now,
			updatedBy: opRef(user)
		});
		return _id;
	}
	await OpentronsScannerPositionSet.updateOne(
		{ _id: set._id },
		{ $set: { positions: [slot], positionCount: 1, pipetteMount: mount, pipetteName: pipetteName ?? undefined, updatedBy: opRef(user) } }
	);
	return String(set._id);
}

export async function saveScanPosition(user: User, robotId: string, input: PointInput): Promise<CalibrationView> {
	await connectDB();
	if (!robotId) throw new ArmWaxFillError('Save the setup (robot) first.');
	const p = cleanPoint(input);
	const prev = (await ArmWaxFillCalibration.findById(robotId).lean()) as any;
	const mount = mountOf(input, prev?.pipetteMount ?? 'left');
	const pipetteName = String(input.pipetteName ?? '').trim() || prev?.pipetteName || null;
	const testScanBarcode = String(input.testScanBarcode ?? '').trim() || null;
	const setId = await upsertScanSet(user, robotId, prev?.scanPositionSetId ?? null, p, mount, pipetteName, testScanBarcode);
	const now = new Date();
	await ArmWaxFillCalibration.updateOne(
		{ _id: robotId },
		{
			$set: {
				scanPosition: { ...p, taughtAt: now, taughtBy: opRef(user), ...(testScanBarcode ? { testScanBarcode, testScannedAt: now } : {}) },
				scanPositionSetId: setId,
				pipetteMount: mount,
				pipetteName,
				updatedBy: opRef(user)
			}
		},
		{ upsert: true }
	);
	await audit(user, 'arm_wax_fill.scan_position', 'arm_wax_fill_calibrations', robotId, { ...p, testScanBarcode, scanPositionSetId: setId, before: point(prev?.scanPosition) });
	return calibrationView(robotId, await ArmWaxFillCalibration.findById(robotId).lean());
}

type CartLocationInput = PointInput & { hasTip?: unknown; adjustX?: unknown; adjustY?: unknown; tipWell?: unknown };

/**
 * The cart location is saved TIP-NEUTRAL, the way the Deck Calibration Studio
 * saves deck holes: the operator teaches with a tip that was just probed on the
 * calibrator, and what is stored is (live − that tip's probe adjust). The stage
 * protocol probes its own tip and adds that adjust back, so the wax lands in the
 * hole whichever tip is on. A point taught without a probed tip would carry the
 * teaching tip's bend into every fill, so it is refused here.
 */
export async function saveCartLocation(user: User, robotId: string, input: CartLocationInput): Promise<CalibrationView> {
	await connectDB();
	if (!robotId) throw new ArmWaxFillError('Save the setup (robot) first.');
	const live = cleanPoint(input);
	const hasTip = String(input.hasTip ?? '') === 'true';
	const ax = Number(input.adjustX);
	const ay = Number(input.adjustY);
	if (!hasTip || !Number.isFinite(ax) || !Number.isFinite(ay)) {
		throw new ArmWaxFillError(
			'Pick up a tip and calibrate it on the tip calibrator before saving the cart location. ' +
				'The fill probes every tip the same way and adds that adjust back, so the saved point has to be ' +
				'tip-neutral (live minus the probe adjust); a point taught without a probed tip would put the wax beside the hole.'
		);
	}
	const p = { x: +(live.x - ax).toFixed(3), y: +(live.y - ay).toFixed(3), z: live.z };
	const prev = (await ArmWaxFillCalibration.findById(robotId).lean()) as any;
	const mount = mountOf(input, prev?.pipetteMount ?? 'left');
	const pipetteName = String(input.pipetteName ?? '').trim() || prev?.pipetteName || null;
	const tipWell = String(input.tipWell ?? '').trim().toUpperCase() || null;
	const now = new Date();
	await ArmWaxFillCalibration.updateOne(
		{ _id: robotId },
		{
			$set: {
				cartLocation: { ...p, live, tipAdjust: { x: ax, y: ay }, tipWell, taughtAt: now, taughtBy: opRef(user) },
				pipetteMount: mount,
				pipetteName,
				updatedBy: opRef(user)
			}
		},
		{ upsert: true }
	);
	await audit(user, 'arm_wax_fill.cart_location', 'arm_wax_fill_calibrations', robotId, { ...p, live, tipAdjust: { x: ax, y: ay }, tipWell, before: point(prev?.cartLocation) });
	return calibrationView(robotId, await ArmWaxFillCalibration.findById(robotId).lean());
}

/**
 * The dispense depth: how far below the first hole's rim the TIP END sits when
 * wax is dispensed (the stage protocol's `dispense_depth`; negative = hover).
 * Taught by jogging a tip to the wanted height over the first hole — the rim
 * is the taught cart location's Z, so the depth is rim − live. The tip's X/Y
 * probe does not enter into it (Z is not probed), but a tip must be on: the
 * number is about the tip end, not the nozzle.
 */
export async function saveDispenseDepth(user: User, robotId: string, input: { z: unknown; hasTip: unknown }): Promise<CalibrationView> {
	await connectDB();
	if (!robotId) throw new ArmWaxFillError('Save the setup (robot) first.');
	const prev = (await ArmWaxFillCalibration.findById(robotId).lean()) as any;
	const rim = point(prev?.cartLocation);
	if (!rim) throw new ArmWaxFillError("Teach the cart location (the first wax hole's rim) first — the dispense depth is measured down from it.");
	if (String(input.hasTip ?? '') !== 'true') throw new ArmWaxFillError('Pick up a tip first — the dispense depth is where the TIP END sits when wax is dispensed.');
	const liveZ = num(input.z, 'z');
	const mm = depthFromLive(rim.z, liveZ);
	if (mm < DISPENSE_DEPTH_LIMITS.min || mm > DISPENSE_DEPTH_LIMITS.max) {
		throw new ArmWaxFillError(
			`The tip is ${Math.abs(mm)} mm ${mm >= 0 ? 'below' : 'above'} the taught rim (z ${rim.z}). The protocol accepts ` +
				`${DISPENSE_DEPTH_LIMITS.min} (hover ${Math.abs(DISPENSE_DEPTH_LIMITS.min)} mm above) to ${DISPENSE_DEPTH_LIMITS.max} mm into the ${WAX_HOLE_DEPTH_MM} mm-deep hole; deeper snaps tips.`
		);
	}
	const now = new Date();
	await ArmWaxFillCalibration.updateOne(
		{ _id: robotId },
		{ $set: { dispenseDepth: { mm, liveZ, taughtAt: now, taughtBy: opRef(user) }, updatedBy: opRef(user) } },
		{ upsert: true }
	);
	await audit(user, 'arm_wax_fill.dispense_depth', 'arm_wax_fill_calibrations', robotId, { mm, liveZ, rimZ: rim.z, before: prev?.dispenseDepth?.mm ?? null });
	return calibrationView(robotId, await ArmWaxFillCalibration.findById(robotId).lean());
}

type StageEditInput = { wellName: string; dx: number; dy: number; dz: number };

/**
 * The Stage Calibration Studio's apply engine — the twin of the Deck Studio's
 * applyBatch / applyPerWell. Each edit moves ONE hole by its own delta (deck mm,
 * tip-neutral). Two cases:
 *
 *   • every hole, same delta  → the whole cart moved: the taught cart location
 *     (the rigid lattice's origin) is translated and the per-hole corrections
 *     are left alone — "Shift whole cart". This is a re-teach of the first
 *     hole, so the delta is not capped: a cart taught 10–20 mm off is exactly
 *     what it corrects. The only bound is the protocol's arm_cart_x/y/z range
 *     (CART_LOCATION_LIMITS) — the point has to be sendable;
 *   • anything else           → each hole's correction grows by its delta, so the
 *     lattice stays where it was taught and only those holes move. Corrections
 *     are capped at HOLE_OFFSET_LIMIT_MM (the protocol's RTP bound); an edit
 *     that would exceed it is skipped and reported, never clamped — the report
 *     says to shift the whole cart instead.
 *
 * Every hole moved gets a "Recent edits" entry (delta + position after), so the
 * Studio's history table and client-side undo (apply the inverse) work as on a deck.
 */
export async function applyStageEdits(
	user: User,
	robotId: string,
	rawEdits: unknown,
	rawLabel: unknown
): Promise<{ calibration: CalibrationView; applied: number; failed: { wellName: string; reason: string }[]; mode: 'translate' | 'offsets' }> {
	await connectDB();
	if (!robotId) throw new ArmWaxFillError('Save the setup (robot) first.');
	let parsed: any;
	try {
		parsed = typeof rawEdits === 'string' ? JSON.parse(rawEdits) : rawEdits;
	} catch {
		throw new ArmWaxFillError('edits must be JSON.');
	}
	if (!Array.isArray(parsed) || parsed.length === 0) throw new ArmWaxFillError('No edits.');
	const edits: StageEditInput[] = [];
	for (const e of parsed) {
		const wellName = String(e?.wellName ?? '').trim().toUpperCase();
		const dx = Number(e?.dx ?? 0), dy = Number(e?.dy ?? 0), dz = Number(e?.dz ?? 0);
		if (!STAGE_WELL_NAMES.includes(wellName)) throw new ArmWaxFillError(`${wellName || '(blank)'} is not one of the cart's wax holes.`);
		if (![dx, dy, dz].every(Number.isFinite)) throw new ArmWaxFillError(`Delta for ${wellName} must be numbers.`);
		if (edits.some((x) => x.wellName === wellName)) throw new ArmWaxFillError(`${wellName} appears twice.`);
		edits.push({ wellName, dx, dy, dz });
	}
	const label = String(rawLabel ?? '').trim().slice(0, 120) || null;
	const prev = (await ArmWaxFillCalibration.findById(robotId).lean()) as any;
	const rim = point(prev?.cartLocation);
	if (!rim) throw new ArmWaxFillError('Teach the cart location (the first wax hole) first — the holes are laid out from it.');
	const rotation = Number.isFinite(Number(prev?.stageRotationDeg)) ? Number(prev.stageRotationDeg) : 0;
	const offsets = offsetsOf(prev);
	const failed: { wellName: string; reason: string }[] = [];
	const uniform = edits.every((e) => e.dx === edits[0].dx && e.dy === edits[0].dy && e.dz === edits[0].dz);
	const whole = edits.length === STAGE_WELL_NAMES.length && uniform;
	let cart = { x: rim.x, y: rim.y, z: rim.z };
	let moved: StageEditInput[] = [];
	if (whole) {
		const d = edits[0];
		if (d.dx === 0 && d.dy === 0 && d.dz === 0) throw new ArmWaxFillError('Zero delta — nothing to apply.');
		cart = { x: +(rim.x + d.dx).toFixed(3), y: +(rim.y + d.dy).toFixed(3), z: +(rim.z + d.dz).toFixed(3) };
		const { xy, z } = CART_LOCATION_LIMITS;
		if (cart.x < xy.min || cart.x > xy.max || cart.y < xy.min || cart.y > xy.max || cart.z < z.min || cart.z > z.max) {
			throw new ArmWaxFillError(
				`Shifting the whole cart by (${d.dx}, ${d.dy}, ${d.dz}) would put the first hole at (${cart.x}, ${cart.y}, ${cart.z}), ` +
					`outside the protocol's ${xy.min}–${xy.max} mm (x, y) / ${z.min}–${z.max} mm (z) range.`
			);
		}
		moved = edits;
	} else {
		for (const e of edits) {
			if (e.dx === 0 && e.dy === 0 && e.dz === 0) continue;
			const cur = offsets[e.wellName] ?? { dx: 0, dy: 0, dz: 0 };
			const next = { dx: +(cur.dx + e.dx).toFixed(3), dy: +(cur.dy + e.dy).toFixed(3), dz: +(cur.dz + e.dz).toFixed(3) };
			if (Math.max(Math.abs(next.dx), Math.abs(next.dy), Math.abs(next.dz)) > HOLE_OFFSET_LIMIT_MM) {
				failed.push({ wellName: e.wellName, reason: `correction would be ${JSON.stringify(next)} — over the ±${HOLE_OFFSET_LIMIT_MM} mm the protocol accepts; shift the whole grid instead` });
				continue;
			}
			offsets[e.wellName] = next;
			moved.push(e);
		}
		if (!moved.length) {
			throw new ArmWaxFillError(
				failed.length ? `Nothing applied — ${failed.map((f) => `${f.wellName}: ${f.reason}`).join('; ')}` : 'Zero delta — nothing to apply.'
			);
		}
	}
	const after = new Map(stageTargets(cart.x, cart.y, cart.z, rotation, offsets).map((h) => [h.name, h]));
	const now = new Date();
	const history = moved.map((e) => ({
		_id: generateId(),
		at: now,
		by: opRef(user),
		label,
		wellName: e.wellName,
		delta: { x: e.dx, y: e.dy, z: e.dz },
		after: { x: after.get(e.wellName)!.x, y: after.get(e.wellName)!.y, z: after.get(e.wellName)!.z }
	}));
	const $set: Record<string, unknown> = {
		holeOffsets: STAGE_WELL_NAMES.filter((n) => offsets[n]).map((n) => ({ name: n, ...offsets[n] })),
		updatedBy: opRef(user)
	};
	if (whole) $set['cartLocation'] = { ...(prev.cartLocation ?? {}), x: cart.x, y: cart.y, z: cart.z };
	await ArmWaxFillCalibration.updateOne({ _id: robotId }, { $set, $push: { edits: { $each: history, $slice: -200 } } });
	await audit(user, 'arm_wax_fill.stage_edit', 'arm_wax_fill_calibrations', robotId, {
		mode: whole ? 'translate' : 'offsets',
		label,
		edits: moved,
		failed,
		cartLocationBefore: { x: rim.x, y: rim.y, z: rim.z },
		cartLocationAfter: cart
	});
	return { calibration: calibrationView(robotId, await ArmWaxFillCalibration.findById(robotId).lean()), applied: moved.length, failed, mode: whole ? 'translate' : 'offsets' };
}

/**
 * The arm's OT-2 has no deck, so its tip-calibrator point is the robot-keyed
 * TipCalibratorFixture row (`deckKey: null`) — the row loadCalibratorFixture
 * returns for a run with no deck binding, which is how the stage fill reads
 * cal_x / cal_y / z_cal. Approach XY+Z and the p20 probe Z (zCalWax); the
 * reagent probe Z is carried forward untouched.
 */
export async function saveStageCalibrator(
	user: User,
	robotId: string,
	input: { x: unknown; y: unknown; z: unknown; probeZ?: unknown; tipProfile?: unknown; zCalWax?: unknown; maxTipAdjust?: unknown }
): Promise<{ position: { x: number; y: number; z: number }; probeZ: number; tipProfile: TipProfile; maxTipAdjust: number | null }> {
	await connectDB();
	if (!robotId) throw new ArmWaxFillError('Save the setup (robot) first.');
	const x = num(input.x, 'calX');
	const y = num(input.y, 'calY');
	const z = num(input.z, 'Approach Z');
	if (plausibleZ(z) === undefined) throw new ArmWaxFillError(`Approach Z must be between ${CAL_Z_LIMITS.min} and ${CAL_Z_LIMITS.max} mm.`);
	if (x < 1 || y < 1) throw new ArmWaxFillError('calX / calY look untaught (below 1 mm) — jog onto the fixture and use "From live".');
	// Which tip's probe depth this is: the page sends the profile it teaches with
	// (the protocol on the robot decides — see stageTipProfile). Old callers that
	// only send zCalWax keep writing the p20's depth.
	const tipProfile: TipProfile = asTipProfile(input.tipProfile) ?? 'wax';
	const spec = TIP_PROFILE[tipProfile];
	const other = TIP_PROFILE[tipProfile === 'wax' ? 'reagent' : 'wax'];
	const rawProbe = input.probeZ ?? input.zCalWax;
	const prev = (await TipCalibratorFixture.findOne({ robotId, deckKey: null }).lean()) as any;
	let probeZ: number;
	if (rawProbe !== null && rawProbe !== undefined && String(rawProbe).trim() !== '') {
		const v = plausibleZ(Number(rawProbe));
		if (v === undefined) throw new ArmWaxFillError(`Probe Z must be between ${CAL_Z_LIMITS.min} and ${CAL_Z_LIMITS.max} mm.`);
		probeZ = v;
	} else {
		probeZ = plausibleZ(Number(prev?.[spec.zCalKey])) ?? spec.defaultZ;
	}
	let maxTipAdjust: number | null = prev?.maxTipAdjust ?? null;
	if (input.maxTipAdjust !== null && input.maxTipAdjust !== undefined && String(input.maxTipAdjust).trim() !== '') {
		const v = Number(input.maxTipAdjust);
		if (!Number.isFinite(v) || v < 0.3 || v > 12) throw new ArmWaxFillError('Max tip adjust must be 0.3–12 mm.');
		maxTipAdjust = v;
	}
	const now = new Date();
	await TipCalibratorFixture.updateOne(
		{ robotId, deckKey: null },
		{
			$set: { position: { x, y, z }, [spec.zCalKey]: probeZ, maxTipAdjust, capturedBy: opRef(user), capturedAt: now, deckLoadName: null },
			$setOnInsert: { _id: generateId(), robotId, deckKey: null, [other.zCalKey]: other.defaultZ }
		},
		{ upsert: true }
	);
	await audit(user, 'arm_wax_fill.calibrator', 'tip_calibrator_fixtures', robotId, {
		position: { x, y, z },
		tipProfile,
		[spec.zCalKey]: probeZ,
		maxTipAdjust,
		before: prev ? { position: prev.position, zCalWax: prev.zCalWax, zCalReagent: prev.zCalReagent, maxTipAdjust: prev.maxTipAdjust ?? null } : null
	});
	return { position: { x, y, z }, probeZ, tipProfile, maxTipAdjust };
}

/**
 * The cart's rotation on the stage. (No travel height any more: the pipette
 * goes all the way up before every move — see the header.)
 */
export async function saveStageGeometry(user: User, robotId: string, input: { rotationDeg: unknown }): Promise<CalibrationView> {
	await connectDB();
	if (!robotId) throw new ArmWaxFillError('Save the setup (robot) first.');
	const rotationDeg = input.rotationDeg === null || String(input.rotationDeg).trim() === '' ? STAGE_ROTATION_DEFAULT_DEG : num(input.rotationDeg, 'Cart rotation');
	if (rotationDeg < -360 || rotationDeg > 360) throw new ArmWaxFillError('Cart rotation must be between −360° and 360°.');
	const prev = (await ArmWaxFillCalibration.findById(robotId).lean()) as any;
	await ArmWaxFillCalibration.updateOne(
		{ _id: robotId },
		{ $set: { stageRotationDeg: rotationDeg, updatedBy: opRef(user) }, $unset: { stageJumpHeightMm: '' } },
		{ upsert: true }
	);
	await audit(user, 'arm_wax_fill.stage_geometry', 'arm_wax_fill_calibrations', robotId, {
		rotationDeg,
		before: { rotationDeg: prev?.stageRotationDeg ?? null }
	});
	return calibrationView(robotId, await ArmWaxFillCalibration.findById(robotId).lean());
}

// ── page load ────────────────────────────────────────────────────────────

export interface ProtocolView {
	opentronsProtocolId: string;
	protocolName: string;
	/** The protocol declares arm_cart_x/y/z, so the taught cart location is sent to it. */
	declaresCartLocation: boolean;
	/** The p300 / air REHEARSAL of the stage fill (declares z_cal_p300): walks every station, dispenses nothing. */
	rehearsal: boolean;
	/** The protocol serves a whole loop in one run (declares cartridges + arm_scan_x/y/z — ARM-WAX-LOOP-B §5.3). */
	declaresLoop: boolean;
}

/** A stage protocol in the library the Wax fill tab can put on the arm's OT-2. */
export interface ProtocolOption {
	libraryId: string;
	protocolName: string;
	fileName: string;
	rehearsal: boolean;
	/** Its file is the robot's current wax-filling entry. */
	onRobot: boolean;
	lastDeployedAt: string | null;
	lastDeployedBy: string | null;
	/** First 8 hex of the row's sha256 — tells two rows of the same file name apart. */
	fileHash8: string;
	/** When the row was filed in the library. */
	addedAt: string | null;
}

export interface LoopCycleView {
	index: number;
	step: string;
	startedAt: string | null;
	endedAt: string | null;
	grabArmRunId: string | null;
	sweepRunId: string | null;
	barcode: string | null;
	waxRunId: string | null;
	opentronsRunId: string | null;
	opentronsRunFinalStatus: string | null;
	withdrawArmRunId: string | null;
	/** Fail route: the step that failed (FailRouteStep) and the arm run of the fail animation. */
	failedStep: string | null;
	failArmRunId: string | null;
	/** ARM-WAX-LOOP-B: the instruction seqs this cycle sent (scan / fill / skip) and when the protocol answered. */
	scanSeq: number | null;
	fillSeq: number | null;
	skipSeq: number | null;
	scanReadAt: string | null;
	filledAt: string | null;
	/** When the OT-2 confirmed its gantry home before each arm move (cycleHomeGantry). */
	gantryHomedForGrabAt: string | null;
	gantryHomedForWithdrawAt: string | null;
	gantryHomedForFailAt: string | null;
	error: string | null;
}

export interface LoopView {
	_id: string;
	robot: { _id: string; name: string };
	cartPosition: number;
	requestedRuns: number;
	completedRuns: number;
	status: 'running' | 'completed' | 'stopped' | 'failed';
	stopRequested: boolean;
	grabAnimation: AnimationRef | null;
	withdrawAnimation: AnimationRef | null;
	failAnimation: AnimationRef | null;
	cycles: LoopCycleView[];
	/** ARM-WAX-LOOP-B: the loop's ONE wax run + OT-2 run, the instruction channel, the run's end. */
	waxRunId: string | null;
	opentronsRunId: string | null;
	instructionSeq: number;
	pendingInstruction: { seq: number; cart: number; action: string; barcode: string | null } | null;
	ending: boolean;
	runFinished: boolean;
	opentronsRunFinalStatus: string | null;
	error: string | null;
	startedBy: string | null;
	startedAt: string | null;
	endedAt: string | null;
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

function loopView(d: any): LoopView {
	return {
		_id: String(d._id),
		robot: { _id: String(d.robot?._id ?? ''), name: d.robot?.name ?? '' },
		cartPosition: Number(d.cartPosition) || 1,
		requestedRuns: Number(d.requestedRuns) || 0,
		completedRuns: Number(d.completedRuns) || 0,
		status: d.status,
		stopRequested: !!d.stopRequested,
		grabAnimation: animRef(d.grabAnimation),
		withdrawAnimation: animRef(d.withdrawAnimation),
		failAnimation: animRef(d.failAnimation),
		cycles: (d.cycles ?? []).map(
			(c: any): LoopCycleView => ({
				index: Number(c.index),
				step: c.step ?? 'grab',
				startedAt: iso(c.startedAt),
				endedAt: iso(c.endedAt),
				grabArmRunId: c.grabArmRunId ?? null,
				sweepRunId: c.sweepRunId ?? null,
				barcode: c.barcode ?? null,
				waxRunId: c.waxRunId ?? null,
				opentronsRunId: c.opentronsRunId ?? null,
				opentronsRunFinalStatus: c.opentronsRunFinalStatus ?? null,
				withdrawArmRunId: c.withdrawArmRunId ?? null,
				failedStep: c.failedStep ?? null,
				failArmRunId: c.failArmRunId ?? null,
				scanSeq: c.scanSeq ?? null,
				fillSeq: c.fillSeq ?? null,
				skipSeq: c.skipSeq ?? null,
				scanReadAt: iso(c.scanReadAt),
				filledAt: iso(c.filledAt),
				gantryHomedForGrabAt: iso(c.gantryHomedForGrabAt),
				gantryHomedForWithdrawAt: iso(c.gantryHomedForWithdrawAt),
				gantryHomedForFailAt: iso(c.gantryHomedForFailAt),
				error: c.error ?? null
			})
		),
		waxRunId: d.waxRunId ?? null,
		opentronsRunId: d.opentronsRunId ?? null,
		instructionSeq: Number(d.instructionSeq ?? 0),
		pendingInstruction: d.pendingInstruction?.action
			? { seq: Number(d.pendingInstruction.seq ?? 0), cart: Number(d.pendingInstruction.cart ?? 0), action: String(d.pendingInstruction.action), barcode: d.pendingInstruction.barcode ?? null }
			: null,
		ending: !!d.ending,
		runFinished: !!d.runFinished,
		opentronsRunFinalStatus: d.opentronsRunFinalStatus ?? null,
		error: d.error ?? null,
		startedBy: d.startedBy?.username ?? null,
		startedAt: iso(d.startedAt),
		endedAt: iso(d.endedAt)
	};
}

export async function getLoop(id: string): Promise<LoopView | null> {
	await connectDB();
	const d = await ArmWaxFillRun.findById(id).lean();
	return d ? loopView(d) : null;
}

export async function activeLoop(): Promise<LoopView | null> {
	await connectDB();
	const d = await ArmWaxFillRun.findOne({ status: 'running' }).sort({ createdAt: -1 }).lean();
	return d ? loopView(d) : null;
}

async function protocolFor(robotId: string | null): Promise<ProtocolView | null> {
	if (!robotId) return null;
	const entry = await currentProtocolEntry(robotId, 'wax-filling');
	if (!entry) return null;
	const declared = new Set(((entry.parametersSchema ?? []) as any[]).map((p) => p?.variableName));
	const protocolName = entry.protocolName ?? 'wax-filling';
	return {
		opentronsProtocolId: String(entry.opentronsProtocolId),
		protocolName,
		declaresCartLocation: CART_LOCATION_RTPS.every((k) => declared.has(k)),
		rehearsal: declared.has(REHEARSAL_RTP) || /rehearsal/i.test(protocolName),
		declaresLoop: declared.has('cartridges') && ['arm_scan_x', 'arm_scan_y', 'arm_scan_z'].every((k) => declared.has(k))
	};
}

/**
 * The stage protocols in the library (active wax-filling rows whose .py declares
 * arm_cart_x) — the production fill and the p300 rehearsal — with whether each
 * is the file on the robot now and when it last went to this robot.
 */
export async function listStageProtocolOptions(robotId: string, current: ProtocolView | null): Promise<ProtocolOption[]> {
	await connectDB();
	// A stage .py filed under 'other' (the library API's default) is still offered; deploy files it under wax-filling.
	const rows = (await OpentronProtocol.find({ processType: { $in: ['wax-filling', 'other'] }, isActive: true })
		.select('_id protocolName fileName fileHash createdAt fileContent deployments.robotId deployments.deployedAt deployments.deployedBy updatedAt')
		.sort({ createdAt: -1 })
		.lean()) as any[];
	return rows
		.filter((r) => String(r.fileContent ?? '').includes(STAGE_MARKER))
		.map((r) => {
			const mine = ((r.deployments ?? []) as any[])
				.filter((d) => String(d.robotId) === String(robotId))
				.sort((a, b) => new Date(b.deployedAt ?? 0).getTime() - new Date(a.deployedAt ?? 0).getTime());
			const fileName = String(r.fileName ?? r.protocolName);
			return {
				libraryId: String(r._id),
				protocolName: String(r.protocolName ?? fileName),
				fileName,
				rehearsal: String(r.fileContent).includes(REHEARSAL_MARKER),
				onRobot: !!current && current.protocolName === fileName,
				lastDeployedAt: iso(mine[0]?.deployedAt),
				lastDeployedBy: mine[0]?.deployedBy ?? null,
				fileHash8: String(r.fileHash ?? '').slice(0, 8),
				addedAt: iso(r.createdAt)
			};
		});
}

/**
 * File a stage .py in the library AS THE ONE ROW FOR THAT FILE NAME. The generic
 * library POST only ever inserts, so re-adding a corrected .py left the old row
 * active beside the new one; the picker then listed two identical names and the
 * old one was deployed again (2026-10-29, the rehearsal's RTP-description fix
 * never reached the robot). Here: a row with the same sha256 is reused, otherwise
 * a new row is created, and every OTHER active wax-filling / other row with the
 * same file name is archived (isActive false — its deployment history stays).
 */
export async function addStageProtocolToLibrary(
	user: User,
	input: { fileName: unknown; content: unknown }
): Promise<{ libraryId: string; reused: boolean; archived: string[]; fileHash8: string }> {
	await connectDB();
	const fileName = String(input.fileName ?? '').trim();
	const content = String(input.content ?? '');
	if (!/\.py$/i.test(fileName)) throw new ArmWaxFillError('Pick a .py file.');
	if (!content.trim()) throw new ArmWaxFillError(`${fileName} is empty.`);
	if (!content.includes(STAGE_MARKER)) throw new ArmWaxFillError(`${fileName} does not declare arm_cart_x/y/z — only a stage protocol goes in from here.`);
	const fileHash = crypto.createHash('sha256').update(content).digest('hex');
	const same = (await OpentronProtocol.findOne({ fileHash, isActive: true }).select('_id').lean()) as any;
	let libraryId: string;
	let reused = false;
	if (same) {
		libraryId = String(same._id);
		reused = true;
	} else {
		libraryId = generateId();
		await OpentronProtocol.create({
			_id: libraryId,
			protocolName: fileName.replace(/\.py$/i, ''),
			description: 'Robot-arm stage protocol (added from the Wax fill tab)',
			processType: 'wax-filling',
			fileName,
			fileHash,
			fileContent: content,
			tags: [],
			uploadedBy: user.username
		});
	}
	const others = (await OpentronProtocol.find({
		_id: { $ne: libraryId },
		fileName,
		isActive: true,
		processType: { $in: ['wax-filling', 'other'] }
	})
		.select('_id fileHash')
		.lean()) as any[];
	const archived = others.map((o) => String(o._id));
	if (archived.length) {
		await OpentronProtocol.updateMany({ _id: { $in: archived } }, { $set: { isActive: false, lastModifiedBy: user.username } });
	}
	await audit(user, 'arm_wax_fill.library_replace', 'opentrons_protocols', libraryId, {
		fileName,
		fileHash,
		reused,
		archived: others.map((o) => ({ _id: String(o._id), fileHash: o.fileHash ?? null }))
	});
	return { libraryId, reused, archived, fileHash8: fileHash.slice(0, 8) };
}

/**
 * Put a stage protocol from the library on the arm's OT-2 and make it the
 * robot's wax-filling protocol. The Opentrons page's Deploy only writes the
 * library's deployments[] (what the run-start re-sync reads) and the Robots
 * page's upload only writes the robot's protocols[] (what this tab, the Stage
 * studio and cycleFill read); a fill needs both to agree, so this writes both.
 * Robot half over the server line (the queue on Vercel): the .py + the BIMS
 * labware it loads, then the on-robot analysis. The robot's entry is only
 * repointed when that analysis completed — a failed upload leaves the robot
 * on the protocol it had.
 */
export async function deployStageProtocol(user: User, rawLibraryId: unknown): Promise<{ protocol: ProtocolView; analysisStatus: string }> {
	await connectDB();
	const libraryId = String(rawLibraryId ?? '').trim();
	if (!libraryId) throw new ArmWaxFillError('Pick a protocol to deploy.');
	const settings = await getSettings();
	if (!settings.robotId) throw new ArmWaxFillError('Setup: pick the OT-2 the arm feeds first.');
	if (await activeLoop()) throw new ArmWaxFillError('A loop is running — stop it before changing the protocol on the robot.', 409);
	const robot = await getRobot(settings.robotId);
	if (!robot) throw new ArmWaxFillError('Robot not found.', 404);
	const row = (await OpentronProtocol.findById(libraryId).lean()) as any;
	if (!row || row.isActive === false || !['wax-filling', 'other'].includes(row.processType)) throw new ArmWaxFillError('That protocol is not an active wax-filling protocol in the library.', 404);
	const content = String(row.fileContent ?? '');
	if (!content.includes(STAGE_MARKER)) throw new ArmWaxFillError(`${row.protocolName} does not declare arm_cart_x/y/z — only a stage protocol can go on the arm's OT-2 from here.`);
	if (row.processType !== 'wax-filling') {
		// The run-start re-sync looks the robot's .py up under 'wax-filling'; a stage protocol filed as 'other' would never be found.
		await OpentronProtocol.updateOne({ _id: row._id }, { $set: { processType: 'wax-filling', lastModifiedBy: user.username } });
		await audit(user, 'arm_wax_fill.protocol_process_type', 'opentrons_protocols', String(row._id), { from: row.processType, to: 'wax-filling' });
	}
	const fileName = String(row.fileName ?? `${row.protocolName}.py`);
	const rehearsal = content.includes(REHEARSAL_MARKER);
	const robotId = String(robot._id);

	const bundle = await assembleProtocolUpload(robot, fileName, content);
	let uploaded;
	try {
		uploaded = await uploadAssembledProtocol(robot, bundle);
	} catch (e) {
		throw new ArmWaxFillError(`Upload to ${robot.name} failed: ${e instanceof Error ? e.message : String(e)}`, 502);
	}
	const analysisStatus = uploaded.analysisStatus === 'completed' || uploaded.analysisStatus === 'failed' ? uploaded.analysisStatus : 'pending';
	const analysisErrors: string[] = uploaded.analysisErrors ?? [];

	// The library row: deployment history + (on a completed analysis) the requirements, as the Opentrons page's Deploy records them.
	const set: Record<string, unknown> = {};
	if (analysisStatus === 'completed') {
		set.parametersSchema = uploaded.parametersSchema ?? null;
		set.labwareRequired = ((uploaded.labwareDefinitions ?? []) as any[]).map((lw) => ({
			loadName: lw.loadName,
			displayName: lw.displayName ?? lw.loadName,
			slot: lw.location?.slotName,
			isCustom: lw.namespace !== 'opentrons'
		}));
		set.pipettesRequired = ((uploaded.pipettesRequired ?? []) as any[]).map((p) => ({ pipetteName: p.pipetteName, mount: p.mount }));
	}
	await OpentronProtocol.updateOne(
		{ _id: row._id },
		{
			$push: {
				deployments: {
					_id: generateId(),
					robotId,
					robotName: robot.name,
					opentronsProtocolId: uploaded.opentronsProtocolId,
					analysisStatus,
					analysisErrors,
					deployedAt: new Date(),
					deployedBy: user.username
				}
			},
			...(Object.keys(set).length ? { $set: set } : {})
		}
	);
	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_protocols',
		recordId: String(row._id),
		action: 'deploy',
		newData: { robotId, opentronsProtocolId: uploaded.opentronsProtocolId, analysisStatus, analysisErrors, line: 'queue', from: 'arm-wax-fill', rehearsal },
		changedAt: new Date(),
		changedBy: user.username
	});

	// An analysis that 'completed' WITH errors is just as unusable as a failed
	// one: the run-start freshness gate refuses it ("protocol analysis completed
	// with errors"). Say so here, with the errors, instead of reporting success.
	if (analysisStatus !== 'completed' || analysisErrors.length) {
		const how = analysisStatus === 'failed' ? 'FAILED' : analysisStatus === 'completed' ? 'completed WITH ERRORS' : 'did not complete';
		throw new ArmWaxFillError(
			`${fileName} was uploaded to ${robot.name} but its analysis ${how}` +
				`${analysisErrors.length ? `: ${analysisErrors.join(' | ')}` : ''}. ` +
				`The robot keeps its previous wax-filling protocol${analysisStatus === 'completed' ? ' entry; fix the .py (or the labware it loads), add it to the library again and deploy' : ''}.`,
			502
		);
	}
	// The robot's own entry — what this tab, the Stage studio and cycleFill read.
	await recordResyncUpload(robotId, 'wax-filling', fileName, uploaded, user.username, `arm wax fill deploy (${user.username})`);
	await audit(user, 'arm_wax_fill.deploy_protocol', 'opentrons_robots', robotId, {
		libraryId: String(row._id),
		fileName,
		rehearsal,
		opentronsProtocolId: uploaded.opentronsProtocolId
	});
	const protocol = await protocolFor(robotId);
	if (!protocol) throw new ArmWaxFillError('Deployed, but the robot entry could not be read back.', 500);
	return { protocol, analysisStatus };
}

/** Why a loop cannot start yet (empty = ready) and softer notes. */
export function readiness(
	settings: SettingsView,
	calibration: CalibrationView | null,
	protocol: ProtocolView | null,
	active: LoopView | null,
	robotConflict: string | null
): { blocking: string[]; notes: string[] } {
	const blocking: string[] = [];
	const notes: string[] = [];
	// The stage protocol (arm_cart_x/y/z declared) fills the taught point and loads
	// no deck; only the legacy carriage protocol needs a deck + deck position.
	const stage = !!protocol?.declaresCartLocation;
	if (!settings.robotId) blocking.push('Setup: pick the OT-2 the arm feeds.');
	if (!settings.grabAnimation) blocking.push('Animations: choose the grab animation.');
	if (!settings.withdrawAnimation) blocking.push('Animations: choose the withdraw animation.');
	if (!settings.failAnimation) blocking.push('Animations: choose the fail animation (plays instead of the fill when the scan fails; it may be the withdraw animation).');
	if (settings.robotId && !protocol) {
		blocking.push(
			'The robot has no wax-filling protocol uploaded — upload protocols/Wax_Filling_GEN7_ArmStage.py on /opentrons (Robots → Protocols, process wax-filling) and deploy it to this robot first.'
		);
	}
	if (settings.robotId && !calibration?.scanPosition) blocking.push('Calibration: teach the scan position (the run itself goes there to scan; it is sent as arm_scan_x/y/z).');
	if (settings.robotId && protocol && !stage) {
		blocking.push(
			`${protocol.protocolName} is the carriage protocol — the arm line runs one stage protocol per loop. Add the current Wax_Filling_GEN7_ArmStage.py (or the p300 rehearsal) to the library and deploy it to this robot.`
		);
	}
	if (settings.robotId && stage && !protocol?.declaresLoop) {
		blocking.push(
			`${protocol?.protocolName} predates the one-run-per-loop fill (no cartridges / arm_scan_x RTPs). Add the current Wax_Filling_GEN7_ArmStage.py (or the p300 rehearsal) to the library and deploy it to this robot.`
		);
	}
	if (settings.robotId && stage) {
		const cl = calibration?.cartLocation ?? null;
		if (!cl) blocking.push('Stage calibration: teach the cart location — pick up a tip, calibrate it, jog onto the rim of the first wax hole, save (the protocol reads arm_cart_x/y/z).');
		else if (!cl.tipAdjust) blocking.push('Stage calibration: the cart location was taught without a probed tip. Teach it again (pick up a tip, calibrate it, then save) so it is tip-neutral, as the fill expects.');
		else if (!protocol?.rehearsal && /p300/i.test(calibration?.pipetteName ?? ''))
			blocking.push(`Stage calibration: the cart location was taught with the p300 (${calibration?.pipetteName}) while the rehearsal was on the robot. Teach it again with the p20 before a production fill.`);
		if (cl && !calibration?.dispenseDepth) blocking.push('Stage calibration: teach the dispense depth — jog the tip to the height it should dispense at over the first wax hole and save it.');
		if (cl?.tipAdjust && calibration?.dispenseDepth) {
			notes.push(
				`The stage protocol fills the taught cart location (tip-neutral; cart rotation ${calibration.stageRotationDeg}°), dispensing ` +
					`${Math.abs(calibration.dispenseDepth.mm)} mm ${calibration.dispenseDepth.mm >= 0 ? 'below' : 'above'} the rim. The pipette goes all the way up before every move between the tip rack, the calibrator, the tube and the cart. No deck or deck position is used.`
			);
		}
	} else if (settings.robotId && protocol) {
		if (!calibration?.cartLocation) notes.push(`Cart location is not taught. The current protocol does not read it; it fills deck position ${settings.cartPosition} from the deck calibration.`);
		else notes.push(`The current protocol does not declare arm_cart_x/y/z, so the taught cart location is kept but not sent; it fills deck position ${settings.cartPosition}. Upload protocols/Wax_Filling_GEN7_ArmStage.py to fill the stage.`);
	}
	if (settings.robotId && protocol?.rehearsal) {
		notes.push(
			`REHEARSAL protocol on the robot (${protocol.protocolName}): the p300 walks the stage fill with 200 µL tips and air — nothing is dispensed. ` +
				'Real carts and real barcodes are fine: the scanned cart is only CHECKED (a backed cart passes, anything else takes the fail route); it stays in its bucket at backing and nothing is recorded as wax-filled. ' +
				'Deploy the production stage protocol (Setup → Protocol on the robot) before a real fill.'
		);
	}
	if (settings.robotId) {
		notes.push(
			'One OT-2 run and ONE tip serve the whole loop: the protocol takes the tip, probes it once, and between carts parks it in the wax tube (the wax stays warm) and pauses. ' +
				'The arm plays only while the robot reports that pause (ARM PARKED); the run leaves the tube only after the arm has settled, and never goes to the calibrator or over the stage while the arm moves.'
		);
	}
	if (settings.failAnimation) notes.push(`If the scan fails — nothing read, or the cart is not a backed cart — the fail animation "${settings.failAnimation.name ?? ''}" plays instead of the fill and the loop stops.`);
	if (active) blocking.push(`A loop is already running (started ${active.startedAt ? new Date(active.startedAt).toLocaleString() : ''}).`);
	if (robotConflict) blocking.push(`${robotConflict} (Robots page)`);
	return { blocking, notes };
}

/**
 * What the teach panel needs to pick up and probe a tip the way the Deck
 * Calibration Studio does: the p20 rack to press from, the next fresh rack
 * position, and this robot's tip-calibrator point (approach height + probe Z).
 */
export interface TeachAid {
	/**
	 * The tip the page picks up, probes and teaches with — decided by the
	 * wax-filling protocol on the robot (stageTipProfile): 'wax' = the p20 and
	 * its 20 µL rack for the production stage fill; 'reagent' = the p300 and the
	 * 200 µL rack for the p300 / air rehearsal, which probes at its own depth
	 * (z_cal_p300 ← zCalReagent). The probe Z below is that tip's.
	 */
	tipProfile: TipProfile;
	/** 'p20' | 'p300' — for labels. */
	pipette: string;
	/** The rack's tip volume, µL — for labels. */
	tipUl: number;
	/** Which fixture field this tip's probe Z lives in. */
	zCalKey: 'zCalWax' | 'zCalReagent';
	/** The mount to open the run on, unless the operator picks the other. */
	defaultMount: 'left' | 'right';
	tiprackLoadName: string;
	nextTipWell: string;
	nextTipSource: string;
	calibrator: { x: number; y: number; approachZ: number; probeZ: number; source: string; maxTipAdjust: number | null; taughtAt: string | null; taughtBy: string | null };
	/** Whether the robot's current wax-filling protocol declares the per-hole hole_NN_dx/dy/dz RTPs. */
	protocolDeclaresHoleOffsets: boolean;
}

/**
 * Which tip the Stage Calibration Studio teaches with: the protocol on the
 * robot decides. The p300 rehearsal probes and fills (air) with the p300 on
 * the 200 µL rack, so teaching with the p20 would probe the wrong tip at the
 * wrong depth; everything else is the production p20 / wax tip.
 */
export function stageTipProfile(protocol: ProtocolView | null): TipProfile {
	return protocol?.rehearsal ? 'reagent' : 'wax';
}

/** The Stage calibration tab's checklist: what the stage protocol needs from this OT-2, and what is taught. */
export function stageChecklist(calibration: CalibrationView | null, protocol: ProtocolView | null): { key: string; label: string; ok: boolean; detail: string }[] {
	const cl = calibration?.cartLocation ?? null;
	const dd = calibration?.dispenseDepth ?? null;
	return [
		{
			key: 'protocol',
			label: 'Stage protocol on the robot',
			ok: !!protocol?.declaresCartLocation,
			detail: !protocol
				? 'No wax-filling protocol — upload protocols/Wax_Filling_GEN7_ArmStage.py on /opentrons and deploy it to this robot.'
				: protocol.declaresCartLocation
					? `${protocol.protocolName}${protocol.rehearsal ? ' — REHEARSAL: p300, 200 µL tips, air. This page teaches with the p300.' : ''}`
					: `${protocol.protocolName} is the carriage protocol (no arm_cart_x/y/z) — upload Wax_Filling_GEN7_ArmStage.py to this robot.`
		},
		{
			key: 'scan',
			label: 'Scan position (no tip)',
			ok: !!calibration?.scanPosition,
			detail: calibration?.scanPosition ? `x ${calibration.scanPosition.x} · y ${calibration.scanPosition.y} · z ${calibration.scanPosition.z}` : 'Where the gantry scanner reads the cart. Taught with no tip on.'
		},
		{
			key: 'cart',
			label: 'Cart location (first wax hole rim, tip-neutral)',
			ok: !!cl?.tipAdjust,
			detail: !cl ? 'Pick up + calibrate a tip, jog the tip end onto the rim of the first wax hole, save.' : cl.tipAdjust ? `x ${cl.x} · y ${cl.y} · z ${cl.z} (probe ${cl.tipAdjust.x}, ${cl.tipAdjust.y})` : 'Taught without a probed tip — teach again with one.'
		},
		{
			key: 'depth',
			label: 'Dispense depth',
			ok: !!dd,
			detail: dd ? `${Math.abs(dd.mm)} mm ${dd.mm >= 0 ? 'below' : 'above'} the rim (tip end at z ${cl ? (cl.z - dd.mm).toFixed(2) : '?'})` : 'Jog the tip to the height it should dispense at over the first hole and save; without it the protocol hovers 1 mm above the rim.'
		}
	];
}

/** Everything the Stage calibration tab shows for the OT-2 the arm feeds. */
export async function loadStageCalibration() {
	await connectDB();
	const settings = await getSettings();
	const robotId = settings.robotId;
	const [robot, calibration, protocol, active] = await Promise.all([
		robotId ? (OpentronsRobot.findById(robotId).select('_id name').lean() as Promise<any>) : Promise.resolve(null),
		getCalibration(robotId),
		protocolFor(robotId).catch(() => null),
		activeLoop()
	]);
	// The teach aid follows the protocol on the robot (p20 for the fill, p300 for the rehearsal).
	const teach: TeachAid | null = robotId ? await teachAid(robotId, stageTipProfile(protocol), calibration).catch((): TeachAid | null => null) : null;
	const robotName: string | null = robot?.name ?? null;
	return {
		robotId,
		robotName,
		scannerDeviceId: scannerDeviceIdForRobot(robotName),
		calibration,
		protocol,
		teach,
		loopRunning: !!active,
		checklist: stageChecklist(calibration, protocol)
	};
}

async function teachAid(robotId: string, profile: TipProfile, calibration: CalibrationView | null): Promise<TeachAid> {
	const spec = TIP_PROFILE[profile];
	const [cal, tip, entry] = await Promise.all([
		resolveCalibratorPoint(robotId, profile, {}),
		nextStudioTipWell(robotId, profile),
		currentProtocolEntry(robotId, 'wax-filling').catch(() => null)
	]);
	const declared = new Set(((entry?.parametersSchema ?? []) as any[]).map((p) => p?.variableName));
	// Mount: the one the cart was last taught on if that was this tip, else where
	// the fleet normally carries it (wax p20 right, reagent p300 left). The run
	// discovers whatever is really on the mount; the page warns on a mismatch.
	const taughtWithThisTip = new RegExp(spec.pipette, 'i').test(calibration?.pipetteName ?? '');
	const defaultMount: 'left' | 'right' = taughtWithThisTip && calibration ? calibration.pipetteMount : profile === 'wax' ? 'right' : 'left';
	return {
		tipProfile: profile,
		pipette: spec.pipette,
		tipUl: profile === 'wax' ? 20 : 200,
		zCalKey: spec.zCalKey,
		defaultMount,
		tiprackLoadName: spec.loadName,
		nextTipWell: tip.well,
		nextTipSource: tip.source,
		calibrator: {
			x: cal.point.x,
			y: cal.point.y,
			// The fixture's `position.z` is the approach (park) height; the Studio
			// falls back to 38.5 when none is taught. The probe Z is the point's z.
			approachZ: plausibleZ(cal.fixture?.position?.z) ?? 38.5,
			probeZ: cal.point.z,
			source: cal.source,
			maxTipAdjust: typeof cal.fixture?.maxTipAdjust === 'number' ? cal.fixture.maxTipAdjust : null,
			taughtAt: iso(cal.fixture?.capturedAt),
			taughtBy: cal.fixture?.capturedBy?.username ?? null
		},
		protocolDeclaresHoleOffsets: declared.has('hole_01_dx') && declared.has('hole_12_dz')
	};
}

export async function loadArmWaxFill() {
	await connectDB();
	const settings = await getSettings();
	const [robots, moveSets, sequences, calibration, protocol, active, recent, robotConflict] = await Promise.all([
		OpentronsRobot.find({ isActive: { $ne: false } }).select('_id name').sort({ name: 1 }).lean(),
		listMoveSets().catch(() => []),
		listSequences().catch(() => []),
		getCalibration(settings.robotId),
		protocolFor(settings.robotId).catch(() => null),
		activeLoop(),
		ArmWaxFillRun.find({ status: { $ne: 'running' } }).sort({ createdAt: -1 }).limit(8).lean(),
		settings.robotId ? checkRobotConflict(settings.robotId).catch(() => null) : Promise.resolve(null)
	]);
	// The teach aid follows the protocol on the robot (p20 for the fill, p300 for the rehearsal).
	const teach: TeachAid | null = settings.robotId ? await teachAid(settings.robotId, stageTipProfile(protocol), calibration).catch((): TeachAid | null => null) : null;
	const robotName = (robots as any[]).find((r) => String(r._id) === settings.robotId)?.name ?? null;
	const protocolOptions: ProtocolOption[] = settings.robotId
		? await listStageProtocolOptions(settings.robotId, protocol).catch(() => [])
		: [];
	// Bridge-heartbeat health of the OT-2 the arm feeds (ready / busy / hung /
	// offline), the same read the Robots board makes; the page polls
	// /api/opentrons-lab/robots/health for the same shape afterwards.
	const health: RobotHealth | null = settings.robotId
		? ((await getRobotsHealth([{ _id: settings.robotId, name: robotName }]).catch(() => ({}) as Record<string, RobotHealth>))[settings.robotId] ?? null)
		: null;
	return {
		settings,
		robotName,
		health,
		scannerDeviceId: scannerDeviceIdForRobot(robotName),
		robots: (robots as any[]).map((r) => ({ _id: String(r._id), name: r.name ?? String(r._id) })),
		moveSets: moveSets.filter((m) => !m.archived).map((m) => ({ _id: m._id, name: m.name, keyframes: m.keyframes.length })),
		sequences: sequences.filter((s) => !s.archived).map((s) => ({ _id: s._id, name: s.name, items: s.items.length })),
		calibration,
		protocol,
		protocolOptions,
		teach,
		activeLoop: active,
		recentLoops: (recent as any[]).map(loopView),
		readiness: readiness(settings, calibration, protocol, active, robotConflict)
	};
}

// ── the loop ─────────────────────────────────────────────────────────────

export async function startLoop(user: User, rawRuns: unknown): Promise<LoopView> {
	await connectDB();
	const requestedRuns = Math.round(num(rawRuns, 'Number of runs'));
	if (requestedRuns < 1 || requestedRuns > 24) throw new ArmWaxFillError('Number of runs must be 1–24: one OT-2 run serves the whole loop and the protocol serves at most 24 carts.');
	const settings = await getSettings();
	const [calibration, protocol, active, robotConflict] = await Promise.all([
		getCalibration(settings.robotId),
		protocolFor(settings.robotId),
		activeLoop(),
		settings.robotId ? checkRobotConflict(settings.robotId) : Promise.resolve(null)
	]);
	const r = readiness(settings, calibration, protocol, active, robotConflict);
	if (r.blocking.length) throw new ArmWaxFillError(r.blocking.join(' '), 409);
	if (!protocol || !protocol.declaresCartLocation || !protocol.declaresLoop || !calibration?.cartLocation || !calibration.dispenseDepth || !calibration.scanPosition) {
		throw new ArmWaxFillError('The loop needs the one-run stage protocol on the robot and a taught cart location, dispense depth and scan position.', 409);
	}
	const robot = await getRobot(settings.robotId!);
	if (!robot) throw new ArmWaxFillError('The OT-2 is not registered or not active.', 409);
	const now = new Date();
	const _id = generateId();
	await ArmWaxFillRun.create({
		_id,
		robot: { _id: String(robot._id), name: robot.name ?? String(robot._id) },
		cartPosition: settings.cartPosition,
		requestedRuns,
		completedRuns: 0,
		status: 'running',
		grabAnimation: settings.grabAnimation,
		withdrawAnimation: settings.withdrawAnimation,
		failAnimation: settings.failAnimation,
		cycles: [{ index: 1, step: 'grab', startedAt: now }],
		instructionSeq: 0,
		startedBy: opRef(user),
		startedAt: now
	});
	const loop = (await ArmWaxFillRun.findById(_id).lean()) as any;
	const abort = async (why: string) => {
		const at = new Date();
		await patchCycle(_id, 1, { step: 'failed', error: why, endedAt: at });
		await ArmWaxFillRun.updateOne({ _id }, { $set: { status: 'failed', error: why, endedAt: at, runFinished: true, ending: true } });
		await audit(user, 'arm_wax_fill.loop_failed', 'arm_wax_fill_runs', _id, { cycle: 1, step: 'start', error: why });
	};

	// 1. The start record on the robot BEFORE the run plays: the protocol reads it
	//    first thing and refuses to run without it (§5.1).
	try {
		await writeInstruction(user, loop, robot, 'start', 1, null);
	} catch (e) {
		const why = `Could not write the loop's start record on the robot: ${e instanceof Error ? e.message : String(e)}`;
		await abort(why);
		throw new ArmWaxFillError(why, 502);
	}

	// 2. ONE WaxFillingRun for the loop; carts join it as they are scanned and filled.
	const waxRunId = generateId();
	await WaxFillingRun.create({
		_id: waxRunId,
		robot: { _id: String(robot._id), name: robot.name ?? String(robot._id) },
		operator: opRef(user),
		status: 'Loading',
		waxSourceLot: settings.waxSourceLot ?? undefined,
		cartridgeIds: [],
		plannedCartridgeCount: requestedRuns,
		setupTimestamp: now,
		armWaxFill: { loopId: _id, rehearsal: protocol.rehearsal, oneRunPerLoop: true },
		notes: [
			{
				_id: generateId(),
				body: protocol.rehearsal
					? `Robot-arm wax fill REHEARSAL (p300, air, nothing dispensed): one run for loop ${_id} (${requestedRuns} cart${requestedRuns === 1 ? '' : 's'}); carts are checked only — none is put on this run, drawn from its bucket or advanced.`
					: `Robot-arm wax fill: one run for loop ${_id} (${requestedRuns} cart${requestedRuns === 1 ? '' : 's'}) at the taught stage location; one tip for the whole loop, parked in the wax between carts.`,
				phase: 'wax_run',
				author: opRef(user),
				createdAt: now
			}
		]
	});
	await ArmWaxFillRun.updateOne({ _id }, { $set: { waxRunId } });
	await audit(user, 'arm_wax_fill.wax_run_create', 'wax_filling_runs', waxRunId, { loopId: _id, requestedRuns, rehearsal: protocol.rehearsal });

	// 3. The ordinary start (freshness gate, create, play). The protocol homes,
	//    takes its one tip, probes it, aspirates and parks → `ARM PARKED 1`.
	const loopForm = loopRunForm(waxRunId, protocol, calibration, requestedRuns);
	await assertFormWithinSchema(String(robot._id), loopForm);
	const started = await startRunQueue('wax', loopForm, user);
	if (isActionFail(started)) {
		await revertUnstartedWaxRun(user, waxRunId, `start failed: ${started.fail.error}`).catch(() => null);
		await abort(`Wax fill did not start: ${started.fail.error}`);
		throw new ArmWaxFillError(`Wax fill did not start: ${started.fail.error}`, started.fail.status);
	}
	await ArmWaxFillRun.updateOne({ _id }, { $set: { opentronsRunId: started.opentronsRunId } });
	await patchCycle(_id, 1, { waxRunId, opentronsRunId: started.opentronsRunId });
	await audit(user, 'arm_wax_fill.loop_start', 'arm_wax_fill_runs', _id, {
		requestedRuns,
		robotId: String(robot._id),
		cartPosition: settings.cartPosition,
		waxRunId,
		opentronsRunId: started.opentronsRunId,
		rehearsal: protocol.rehearsal,
		grab: settings.grabAnimation,
		withdraw: settings.withdrawAnimation,
		fail: settings.failAnimation
	});
	return (await getLoop(_id))!;
}

/** The running loop and its current (last) cycle, or a clear error. */
async function runningLoop(loopId: string): Promise<{ loop: any; cycle: any }> {
	await connectDB();
	const loop = (await ArmWaxFillRun.findById(loopId).lean()) as any;
	if (!loop) throw new ArmWaxFillError('Loop not found.', 404);
	if (loop.status !== 'running') throw new ArmWaxFillError(`This loop is ${loop.status}.`, 409);
	const cycle = loop.cycles?.[loop.cycles.length - 1];
	if (!cycle) throw new ArmWaxFillError('This loop has no cycle.', 409);
	return { loop, cycle };
}

function expectStep(cycle: any, ...steps: string[]) {
	if (!steps.includes(cycle.step)) throw new ArmWaxFillError(`Cycle ${cycle.index} is at "${cycle.step}", not ${steps.join(' / ')} — reload the page.`, 409);
}

async function patchCycle(loopId: string, index: number, set: Record<string, unknown>) {
	const $set: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(set)) $set[`cycles.$.${k}`] = v;
	await ArmWaxFillRun.updateOne({ _id: loopId, 'cycles.index': index }, { $set });
}

async function play(user: User, ref: AnimationRef | null, what: string): Promise<PlayResult> {
	if (!ref) throw new ArmWaxFillError(`No ${what} animation is set.`, 409);
	try {
		return ref.kind === 'sequence' ? await playSequence(user, ref.id) : await playMoveSet(user, ref.id);
	} catch (err) {
		if (err instanceof AnimateError) throw new ArmWaxFillError(`${what} animation: ${err.message}`, err.status);
		throw err;
	}
}

// ── The OT-2 run is the gate: the arm moves only while the run is PARKED ──
//
// ARM-WAX-LOOP-B (docs/prds/ARM-WAX-LOOP-B-ONE-RUN-PER-LOOP.md §5): ONE OT-2
// run serves the whole loop. The protocol parks its tip in the wax tube and
// pauses `ARM PARKED <i>` whenever the arm may move (grab, withdraw, the fail
// animation — the tube is neither the calibrator nor the stage); it pauses
// `ARM AT_SCAN <i>` with the gantry over the stage, where the arm must not.
// BIMS steers it with the instruction file the bridge daemon writes on the
// robot (/data/arm_loop.json: scan / fill / skip / end) and resumes it; the
// arm plays only after the robot itself reports the PARKED pause for the
// expected cart (assertRunParked) — the stamp the gantry home used to be.

/** Seconds after which an arm-line gantry home no longer counts as fresh for the scanner sweep (legacy per-cart line). */
export const GANTRY_HOME_FRESH_S = 120;

/**
 * Legacy per-cart line, kept for /api/scanner/sweep: seconds since this line
 * homed the gantry for the loop's current cycle. The one-run loop never
 * stamps gantryHomedForGrabAt (the scan is the protocol's own move and the
 * daemon reads the scanner over serial), so this is null for it.
 */
export async function armLineGantryHomedAgoS(loopId: string, robotId: string): Promise<number | null> {
	await connectDB();
	const loop = (await ArmWaxFillRun.findById(loopId).lean()) as any;
	if (!loop || loop.status !== 'running' || String(loop.robot?._id ?? '') !== robotId) return null;
	const cycle = loop.cycles?.[loop.cycles.length - 1];
	const at = cycle?.step === 'scan' ? cycle.gantryHomedForGrabAt : null;
	if (!(at instanceof Date)) return null;
	const ago = (Date.now() - at.getTime()) / 1000;
	return ago >= 0 && ago < GANTRY_HOME_FRESH_S ? Math.round(ago) : null;
}

const waitMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const BRIDGE_POLL_MS = 500;

/**
 * Enqueue a queue-line command for the robot's bridge daemon and wait for its
 * result body (the way /api/scanner/calibrate-tip does). `read_scanner` and
 * `write_file` touch no motion: the daemon's serial scanner and its filesystem.
 */
async function bridgeCommand(
	robot: any,
	user: User,
	kind: 'read_scanner' | 'write_file',
	payload: Record<string, unknown>,
	timeoutMs: number
): Promise<any> {
	const cmd = await Ot2BridgeCommand.create({
		_id: generateId(),
		robotId: String(robot._id),
		deviceId: bridgeDeviceIdForRobot(robot),
		kind,
		payload,
		ttlMs: timeoutMs + 30_000,
		requestedBy: user.username
	});
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const doc = (await Ot2BridgeCommand.findById(cmd._id).select('status result error').lean()) as any;
		if (doc?.status === 'completed') return doc.result?.body ?? {};
		if (doc?.status === 'failed' || doc?.status === 'expired') {
			throw new ArmWaxFillError(`The robot's bridge ${doc.status} the ${kind} command${doc.error ? `: ${doc.error}` : ''}.`, 502);
		}
		await waitMs(BRIDGE_POLL_MS);
	}
	await Ot2BridgeCommand.updateOne(
		{ _id: cmd._id, status: { $in: ['pending', 'claimed'] } },
		{ $set: { status: 'expired', error: 'BIMS gave up waiting for the bridge daemon', completedAt: new Date() } }
	).catch(() => {});
	throw new ArmWaxFillError(`The robot's bridge did not answer the ${kind} command within ${Math.round(timeoutMs / 1000)} s — is the bridge daemon online (and does it know read_scanner / write_file)?`, 504);
}

/**
 * Write the next instruction (§5.1) for the protocol: seq 0 for the start
 * record, else the loop's seq + 1. The record is remembered on the loop as
 * pendingInstruction so a run resumed from outside can be given it again.
 */
async function writeInstruction(user: User, loop: any, robot: any, action: ArmLoopAction, cart: number, barcode: string | null): Promise<number> {
	const seq = action === 'start' ? 0 : Number(loop.instructionSeq ?? 0) + 1;
	const instruction: ArmLoopInstruction = { seq, loop: String(loop._id), cart, action, barcode };
	await ArmWaxFillRun.updateOne({ _id: loop._id }, { $set: { instructionSeq: seq, pendingInstruction: instruction } });
	loop.instructionSeq = seq;
	loop.pendingInstruction = instruction;
	await bridgeCommand(robot, user, 'write_file', { path: ARM_LOOP_INSTRUCTION_PATH, json: instruction }, 60_000);
	await audit(user, 'arm_wax_fill.instruction', 'arm_wax_fill_runs', String(loop._id), { seq, action, cart, barcode });
	return seq;
}

interface RunPauseRead {
	/** The OT-2 run's status (idle / running / paused / succeeded / failed / stopped …). */
	status: string;
	/** The pause's message when the run is paused at a waitForResume, else null. */
	message: string | null;
	/** The message parsed as one of this line's pauses, else null. */
	pause: ArmPause | null;
	/** The last ARM pause or announcement in the run's command log (see armMayMove), else null. */
	last: ArmMarker | null;
}

/**
 * The run's status and, when paused, the waitForResume it is paused at
 * (GET /runs/{id}, then the commands page centred on the current command —
 * the tail of the run when that page falls short).
 */
async function readRunPause(robot: any, runId: string): Promise<RunPauseRead> {
	const read = async (path: string): Promise<any> => {
		const r = await robotGet(robot, path);
		if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
		return r.json();
	};
	let run: any;
	try {
		run = (await read(`/runs/${runId}`))?.data;
	} catch (e) {
		throw new ArmWaxFillError(`The OT-2 run could not be read (${e instanceof Error ? e.message : String(e)}).`, 502);
	}
	const status = String(run?.status ?? 'unknown');
	if (status !== 'paused' && status !== 'running') return { status, message: null, pause: null, last: null };
	// The tail of the command log: the current pause (if any) and the last ARM
	// announcement. Without a cursor the robot centres the page on the current
	// command; re-read from the end when that page does not reach the end.
	const PAGE = 50;
	let cmds: any[] = [];
	try {
		let page = await read(`/runs/${runId}/commands?pageLength=${PAGE}`);
		cmds = Array.isArray(page?.data) ? page.data : [];
		const total = Number(page?.meta?.totalLength ?? 0);
		const end = Number(page?.meta?.cursor ?? 0) + cmds.length;
		if (total > 0 && end < total) {
			page = await read(`/runs/${runId}/commands?cursor=${Math.max(0, total - PAGE)}&pageLength=${PAGE}`);
			cmds = Array.isArray(page?.data) ? page.data : [];
		}
	} catch {
		cmds = [];
	}
	const waits = cmds.filter((c) => c?.commandType === 'waitForResume');
	const cur = status === 'paused' ? (waits.find((c) => c.status === 'running') ?? waits[waits.length - 1] ?? null) : null;
	const message = cur?.params?.message ? String(cur.params.message) : null;
	let last: ArmMarker | null = null;
	for (const c of cmds) {
		if (c?.commandType === 'waitForResume') {
			const p = parseArmPause(c?.params?.message);
			if (p) last = { kind: p.kind, cart: p.cart, paused: c.status === 'running' };
		} else if (c?.commandType === 'comment') {
			const a = parseArmComment(c?.params?.message);
			if (a) last = { kind: a.kind, cart: a.cart, paused: false };
		}
	}
	return { status, message, pause: parseArmPause(message), last };
}

/**
 * The arm may move: parked for `want.parked`, or — the overlap Alejandro asked
 * for — the run still RUNNING right after 'ARM CALIBRATED' (start-up: it now
 * only aspirates and parks) or after 'ARM CLEAR <i>' (it has left the stage
 * for the tube: re-aspirate and park, or trash the tip and home). Anything
 * else — a resumed pause on its way to the scan or the holes, the calibrator,
 * an ended run — refuses.
 */
async function assertArmMayMove(robot: any, loop: any, want: ArmMoveWant, what: string): Promise<RunPauseRead> {
	if (!loop.opentronsRunId) throw new ArmWaxFillError(`This loop has no robot run — the arm will not ${what}.`, 409);
	const r = await readRunPause(robot, String(loop.opentronsRunId));
	if (armMayMove(r.status, r.last, want)) return r;
	const where =
		r.status !== 'paused' && r.status !== 'running'
			? `is ${r.status}`
			: r.status === 'paused'
				? r.message
					? `is paused at "${r.message}"`
					: 'is paused without an ARM note'
				: r.last
					? `is running after "ARM ${r.last.kind}${r.last.cart ? ` ${r.last.cart}` : ''}"`
					: 'is running with no ARM announcement yet';
	throw new ArmWaxFillError(`The OT-2 run ${where} — not clear of the calibrator and the stage for cart ${want.parked - (want.orClear != null ? 1 : 0)}; the arm will not ${what}.`, 409);
}

/** Resume the run (the OT-2's action for it is 'play'; it has no 'resume'). */
async function resumeRun(robot: any, runId: string): Promise<void> {
	let res: Response;
	try {
		res = await robotPost(robot, `/runs/${runId}/actions`, { data: { actionType: 'play' } });
	} catch (e) {
		throw new ArmWaxFillError(`The OT-2 could not be resumed (${e instanceof Error ? e.message : String(e)}).`, 502);
	}
	if (!res.ok) {
		const body: any = await res.json().catch(() => ({}));
		throw new ArmWaxFillError(`The OT-2 refused to resume its run (${body?.message ?? body?.errors?.[0]?.detail ?? `HTTP ${res.status}`}).`, 502);
	}
}

/** What the grab of `cart` needs: parked for it, or running after CALIBRATED (cart 1) / after CLEAR of the previous cart. */
function grabWant(cart: number): ArmMoveWant {
	return cart === 1 ? { parked: 1, orCalibrated: true } : { parked: cart, orClear: cart - 1 };
}

/** What the withdraw / fail animation of `cart` needs: parked for the next cart, or running after CLEAR of this one. */
function afterCartWant(cart: number): ArmMoveWant {
	return { parked: cart + 1, orClear: cart };
}

/** The arm moves only while the run is paused at `ARM PARKED <cart>`: the tip in the wax tube, nothing over the stage. */
async function assertRunParked(robot: any, loop: any, cart: number, what: string): Promise<RunPauseRead> {
	if (!loop.opentronsRunId) throw new ArmWaxFillError(`This loop has no robot run — the arm will not ${what}.`, 409);
	const r = await readRunPause(robot, String(loop.opentronsRunId));
	if (isParkedFor(r.pause, cart)) return r;
	const where = r.status !== 'paused' ? `is ${r.status}` : r.message ? `is paused at "${r.message}"` : 'is paused without an ARM note';
	throw new ArmWaxFillError(`The OT-2 run ${where}, not parked in the wax tube for cart ${cart} — the arm will not ${what}.`, 409);
}

type AwaitResult = { done: true; read: RunPauseRead } | { done: false; terminal: string | null; read: RunPauseRead };

const AWAIT_POLL_MS = 1500;
/** One page action's wait budget (the action's maxDuration is 120 s). */
const AWAIT_BUDGET_MS = 85_000;

/**
 * Wait for the run to pause at `expect`. Returns done:false with `terminal`
 * set when the run ended instead, or with terminal null when the budget ran
 * out (the page calls again). A `NO_INSTRUCTION` pause means the run was
 * resumed from outside the loop and found nothing new: the outstanding
 * instruction for that cart is written again and the run resumed; with none
 * outstanding nothing is safe to send and the wait fails.
 */
async function awaitPause(
	user: User,
	loop: any,
	robot: any,
	expect: ArmPause & { orClear?: number; orCalibrated?: boolean },
	maxWaitMs = AWAIT_BUDGET_MS
): Promise<AwaitResult> {
	const runId = String(loop.opentronsRunId ?? '');
	if (!runId) throw new ArmWaxFillError('This loop has no robot run.', 409);
	const deadline = Date.now() + maxWaitMs;
	for (;;) {
		const r = await readRunPause(robot, runId);
		if (OT2_RUN_TERMINAL.has(r.status)) return { done: false, terminal: r.status, read: r };
		if (r.pause && r.pause.kind === expect.kind && r.pause.cart === expect.cart) return { done: true, read: r };
		// The announcements: the arm may already move while the run keeps going.
		if (expect.kind === 'PARKED' && (expect.orClear != null || expect.orCalibrated) && armMayMove(r.status, r.last, { parked: expect.cart, orClear: expect.orClear, orCalibrated: expect.orCalibrated })) {
			return { done: true, read: r };
		}
		if (r.pause?.kind === 'NO_INSTRUCTION') {
			const p = loop.pendingInstruction;
			if (p && p.action !== 'start' && Number(p.cart) === r.pause.cart) {
				await writeInstruction(user, loop, robot, p.action as ArmLoopAction, Number(p.cart), p.barcode ?? null);
				await audit(user, 'arm_wax_fill.instruction_rewritten', 'arm_wax_fill_runs', String(loop._id), { cart: p.cart, action: p.action, pause: r.message });
				await resumeRun(robot, runId);
			} else {
				throw new ArmWaxFillError(
					`The OT-2 run was resumed from outside this loop and is waiting for an instruction ("${r.message}") BIMS has not issued. Press STOP RUN and start the loop again.`,
					409
				);
			}
		}
		if (Date.now() >= deadline) return { done: false, terminal: null, read: r };
		await waitMs(AWAIT_POLL_MS);
	}
}

/**
 * The robot run ended while a cycle was mid-way (a protocol error, a stop from
 * the Opentrons app, a cancel on the Robots page): record the end on the wax
 * run exactly as a per-cart fill's end was recorded, cancel it when it did not
 * succeed (the robot log decides which carts were finished), and fail the loop.
 */
async function runEndedMidLoop(user: User, loop: any, cycle: any, step: string, status: string): Promise<LoopView> {
	let note = '';
	// The robot's own reason (GET /runs/{id} → data.errors[].detail) — the first
	// loop on the robot failed at the scan move and the page said only "ended failed".
	let detail = '';
	if (loop.opentronsRunId) {
		try {
			const robot = await loopRobot(loop);
			const r = await robotGet(robot, `/runs/${loop.opentronsRunId}`);
			if (r.ok) {
				const errs = (((await r.json()) as any)?.data?.errors ?? []) as any[];
				const why = errs
					.map((e) => String(e?.detail ?? e?.errorType ?? '').trim())
					.filter(Boolean)
					.slice(0, 2)
					.join(' | ');
				if (why) detail = ` Robot: ${why}`;
			}
		} catch {
			/* best effort */
		}
	}
	if (loop.waxRunId) {
		const fin = await recordRunFinishedQueue('wax', String(loop.waxRunId), status, user).catch((e) => ({ fail: { status: 500, error: (e as Error).message } }));
		if (isActionFail(fin)) note += ` The wax run's end could not be recorded (${fin.fail.error}).`;
		if (status !== 'succeeded') {
			const stop = await stopRunQueue('wax', 'cancel', String(loop.waxRunId), { reason: `Robot-arm wax fill: robot run ended ${status} during cycle ${cycle.index}` }, user).catch((e) => ({
				fail: { status: 500, error: (e as Error).message }
			}));
			if (isActionFail(stop)) note += ` The wax run could not be cancelled automatically (${stop.fail.error}) — cancel it on the Robots page.`;
		}
	}
	await ArmWaxFillRun.updateOne({ _id: loop._id }, { $set: { runFinished: true, ending: true, opentronsRunFinalStatus: status } });
	return failLoop(user, String(loop._id), step, `The robot run ended ${status} before the cycle finished.${detail}${note}`, { opentronsRunFinalStatus: status, robotError: detail || null });
}

/** Send `end` and resume: the protocol lifts, trashes the tip and homes. Best effort — the note says when it could not. */
async function sendEnd(user: User, loop: any, robot: any, cart: number): Promise<string | null> {
	if (loop.ending || !loop.opentronsRunId) return null;
	try {
		// The resume that carries `end` needs the run paused at the park; after a
		// CLEAR the park is seconds away.
		const w = await awaitPause(user, loop, robot, { kind: 'PARKED', cart: cart + 1 }, 60_000);
		if (!w.done) throw new Error(w.terminal ? `the robot run ended ${w.terminal}` : 'the run did not park within 60 s');
		await writeInstruction(user, loop, robot, 'end', cart, null);
		await resumeRun(robot, String(loop.opentronsRunId));
		await ArmWaxFillRun.updateOne({ _id: loop._id }, { $set: { ending: true } });
		loop.ending = true;
		await audit(user, 'arm_wax_fill.loop_end_sent', 'arm_wax_fill_runs', String(loop._id), { cart });
		return null;
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		await audit(user, 'arm_wax_fill.loop_end_failed', 'arm_wax_fill_runs', String(loop._id), { cart, error: why });
		return `The end instruction could not be sent (${why}) — the robot run is still parked; press STOP RUN or cancel it on the Robots page.`;
	}
}

/** The loop's robot, or a clear refusal. */
async function loopRobot(loop: any): Promise<any> {
	const robot = await getRobot(String(loop.robot?._id ?? ''));
	if (!robot) throw new ArmWaxFillError('The OT-2 is not registered or not active — the loop cannot go on.', 409);
	return robot;
}

/**
 * Before the grab: wait until the run is parked for this cart — `ARM PARKED 1`
 * after the loop start's home, tip, probe and first aspirate (~70 s), or at
 * once on later carts (the protocol parked before the previous withdraw).
 * Bounded per call; the page calls again while `done` is false.
 */
export async function cycleAwaitParked(user: User, loopId: string): Promise<{ done: boolean; loop: LoopView }> {
	const { loop, cycle } = await runningLoop(loopId);
	// Before the grab (cycles after the first) or before the scan (every cycle:
	// on cycle 1 the grab overlapped the OT-2's start-up, so the run may still
	// be homing / taking its tip / parking when the scan is due).
	if (cycle.step !== 'grab' && cycle.step !== 'scan') expectStep(cycle, 'grab');
	const robot = await loopRobot(loop);
	const want: ArmMoveWant = cycle.step === 'grab' ? grabWant(cycle.index) : { parked: cycle.index };
	const r = await awaitPause(user, loop, robot, { kind: 'PARKED', cart: cycle.index, orClear: want.orClear, orCalibrated: want.orCalibrated });
	if (!r.done && r.terminal) return { done: true, loop: await runEndedMidLoop(user, loop, cycle, String(cycle.step), r.terminal) };
	if (r.done) await audit(user, 'arm_wax_fill.run_parked', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, before: cycle.step, message: r.read.message });
	return { done: r.done, loop: (await getLoop(loopId))! };
}

/** Step 1: the arm MOVES through the grab animation — only while the run is parked for this cart. */
export async function cycleGrab(user: User, loopId: string): Promise<{ play: PlayResult; cycle: number }> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'grab');
	if (loop.stopRequested) throw new ArmWaxFillError('Stop was requested — the loop ends here.', 409);
	const robot = await loopRobot(loop);
	await assertArmMayMove(robot, loop, grabWant(cycle.index), 'grab');
	const p = await play(user, animRef(loop.grabAnimation), 'grab');
	await patchCycle(loopId, cycle.index, { grabArmRunId: p.runId, startedAt: cycle.startedAt ?? new Date() });
	await audit(user, 'arm_wax_fill.cycle_grab', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, armRunId: p.runId, durationS: p.durationS });
	return { play: p, cycle: cycle.index };
}

/** The grab play ended (and was settled): on to the scan. */
export async function cycleGrabDone(user: User, loopId: string): Promise<LoopView> {
	const { cycle } = await runningLoop(loopId);
	expectStep(cycle, 'grab');
	await patchCycle(loopId, cycle.index, { step: 'scan' });
	return (await getLoop(loopId))!;
}

/**
 * Step 2a: tell the protocol to go to the scan position. Only from PARKED —
 * the arm has just finished its grab and settled — and only once per cycle.
 */
export async function cycleScanStart(user: User, loopId: string): Promise<LoopView> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'scan');
	if (cycle.scanSeq) return (await getLoop(loopId))!; // a retry after a reload
	const robot = await loopRobot(loop);
	await assertRunParked(robot, loop, cycle.index, 'send the scan instruction');
	const seq = await writeInstruction(user, loop, robot, 'scan', cycle.index, null);
	await resumeRun(robot, String(loop.opentronsRunId));
	await patchCycle(loopId, cycle.index, { scanSeq: seq });
	await audit(user, 'arm_wax_fill.cycle_scan_sent', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, seq });
	return (await getLoop(loopId))!;
}

/**
 * Step 2b: once the run reports `ARM AT_SCAN <i>` (gantry over the stage, arm
 * still), the daemon reads the scanner over serial — no maintenance run, no
 * motion. Nothing read, or a cart that cannot be filled → the fail route.
 * Bounded; `pending` while the run has not reached the scan position yet.
 */
export async function cycleScanRead(user: User, loopId: string): Promise<{ pending: boolean; loop: LoopView }> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'scan');
	if (!cycle.scanSeq) throw new ArmWaxFillError('The scan instruction has not been sent yet.', 409);
	const robot = await loopRobot(loop);
	const r = await awaitPause(user, loop, robot, { kind: 'AT_SCAN', cart: cycle.index });
	if (!r.done && r.terminal) return { pending: false, loop: await runEndedMidLoop(user, loop, cycle, 'scan', r.terminal) };
	if (!r.done) return { pending: true, loop: (await getLoop(loopId))! };
	let barcode = '';
	let raw = '';
	try {
		const body = await bridgeCommand(robot, user, 'read_scanner', { timeoutS: 15 }, 45_000);
		barcode = String(body?.barcode ?? '').trim();
		raw = String(body?.raw ?? '');
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		await patchCycle(loopId, cycle.index, { scanReadAt: new Date() });
		return { pending: false, loop: await enterFailRoute(user, loopId, cycle, 'scan', `the scanner could not be read: ${why}`) };
	}
	await patchCycle(loopId, cycle.index, { scanReadAt: new Date() });
	await audit(user, 'arm_wax_fill.scan_read', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, barcode: barcode || null, raw: raw.slice(0, 200) });
	if (!barcode) return { pending: false, loop: await enterFailRoute(user, loopId, cycle, 'scan', 'the scanner read nothing') };
	const problem = await cartScanProblem(barcode, (await getSettings()).testMode);
	if (problem) return { pending: false, loop: await enterFailRoute(user, loopId, cycle, 'scan', problem, { barcode }) };
	await patchCycle(loopId, cycle.index, { step: 'decide', barcode });
	await audit(user, 'arm_wax_fill.cycle_scan', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, barcode });
	return { pending: false, loop: (await getLoop(loopId))! };
}

/**
 * Why a barcode the scanner read cannot be filled, or null if it can. The
 * rules attachCart enforces at the fill, checked at the scan so a wrong cart
 * takes the fail route instead of failing the loop with the cart on the stage.
 */
async function cartScanProblem(barcode: string, testMode: boolean): Promise<string | null> {
	const cart = (await CartridgeRecord.findById(barcode).select('_id status').lean()) as any;
	if (!cart) {
		const labels = await findBucketLabels([barcode]);
		if (labels.size > 0) return `${barcode} is the label on bucket ${[...labels.values()][0]}, not a cartridge.`;
		if (testMode) return null; // synthesised as a backed cart at the fill
		return `Cartridge ${barcode} is not in the system (a cart exists once it is scanned into a production bucket; test mode in Setup synthesises test carts).`;
	}
	if (cart.status !== 'backing') return `Cartridge ${barcode} is at "${cart.status ?? '(none)'}" — only backed carts (status backing) can be wax filled.`;
	return null;
}

/**
 * Step 3: the cart is good — put it on the wax run (production: drawn from its
 * bucket, wax_filling; rehearsal: checked only) and tell the protocol to fill.
 * A cart the bucket side refuses takes the fail route from here (the gantry is
 * still at the scan position; the skip brings it back to the tube first).
 */
export async function cycleDecide(user: User, loopId: string): Promise<LoopView> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'decide');
	if (!cycle.barcode) throw new ArmWaxFillError('This cycle has no scanned barcode.', 409);
	if (cycle.fillSeq) return (await getLoop(loopId))!; // a retry after a reload
	const settings = await getSettings();
	const protocol = await protocolFor(String(loop.robot?._id ?? ''));
	const rehearsal = !!protocol?.rehearsal;
	const robot = await loopRobot(loop);
	if (rehearsal) {
		// REHEARSAL: the cart was checked at the scan and that is all that happens to it.
		await audit(user, 'arm_wax_fill.rehearsal_cart', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, waxRunId: loop.waxRunId ?? null, barcode: cycle.barcode, touched: false });
	} else {
		try {
			await attachCart(user, loop, String(loop.waxRunId), cycle.barcode, settings.testMode, loop.cartPosition);
			await WaxFillingRun.updateOne({ _id: loop.waxRunId }, { $addToSet: { cartridgeIds: cycle.barcode } });
		} catch (err) {
			return enterFailRoute(user, loopId, cycle, 'decide', err instanceof Error ? err.message : String(err), { barcode: cycle.barcode });
		}
	}
	const seq = await writeInstruction(user, loop, robot, 'fill', cycle.index, cycle.barcode);
	await resumeRun(robot, String(loop.opentronsRunId));
	await patchCycle(loopId, cycle.index, { step: 'fill', fillSeq: seq, waxRunId: loop.waxRunId ?? null, opentronsRunId: loop.opentronsRunId ?? null });
	await audit(user, 'arm_wax_fill.cycle_fill', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, seq, waxRunId: loop.waxRunId ?? null, opentronsRunId: loop.opentronsRunId ?? null, barcode: cycle.barcode, rehearsal });
	return (await getLoop(loopId))!;
}

/**
 * Step 3b: the fill is the protocol's — wait for `ARM PARKED <i+1>` (12 holes,
 * back to the tube, re-aspirate, park). The run ending instead means the fill
 * did not finish: the end is recorded, the wax run cancelled, the loop fails.
 */
export async function cycleFillWait(user: User, loopId: string): Promise<{ pending: boolean; loop: LoopView }> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'fill');
	const robot = await loopRobot(loop);
	// Done as soon as the run announces 'ARM CLEAR <i>' (left the stage, at the tube); PARKED <i+1> also counts.
	const r = await awaitPause(user, loop, robot, { kind: 'PARKED', cart: cycle.index + 1, orClear: cycle.index });
	if (!r.done && r.terminal) return { pending: false, loop: await runEndedMidLoop(user, loop, cycle, 'fill', r.terminal) };
	if (!r.done) return { pending: true, loop: (await getLoop(loopId))! };
	await patchCycle(loopId, cycle.index, { step: 'withdraw', filledAt: new Date() });
	await audit(user, 'arm_wax_fill.cycle_filled', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, waxRunId: loop.waxRunId ?? null, barcode: cycle.barcode ?? null, message: r.read.message });
	await audit(user, 'arm_wax_fill.run_parked', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, before: 'withdraw', message: r.read.message });
	return { pending: false, loop: (await getLoop(loopId))! };
}

// ── the fail route ────────────────────────────────────────────────────────

/** The cycle leaves the happy path: step 'fail' with the reason on it; the skip and the fail animation are next. */
async function enterFailRoute(user: User, loopId: string, cycle: any, failedStep: FailRouteStep, reason: string, extra: Record<string, unknown> = {}): Promise<LoopView> {
	const msg = String(reason ?? 'failed').slice(0, 2000);
	await patchCycle(loopId, cycle.index, { step: 'fail', failedStep, error: msg, ...extra });
	await audit(user, 'arm_wax_fill.cycle_fail_route', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, failedStep, error: msg, ...extra });
	return (await getLoop(loopId))!;
}

/**
 * Fail route, part 1: the gantry is at the scan position — send `skip` so the
 * protocol lifts, returns to the tube and parks (`ARM PARKED <i+1>`); only then
 * may the arm take the cart away. Bounded; `pending` until the run is parked.
 */
export async function cycleFailPrepare(user: User, loopId: string): Promise<{ pending: boolean; loop: LoopView }> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'fail');
	const robot = await loopRobot(loop);
	if (!cycle.skipSeq) {
		const seq = await writeInstruction(user, loop, robot, 'skip', cycle.index, null);
		await resumeRun(robot, String(loop.opentronsRunId));
		await patchCycle(loopId, cycle.index, { skipSeq: seq });
		await audit(user, 'arm_wax_fill.cycle_skip_sent', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, seq });
	}
	const r = await awaitPause(user, loop, robot, { kind: 'PARKED', cart: cycle.index + 1, orClear: cycle.index });
	if (!r.done && r.terminal) return { pending: false, loop: await runEndedMidLoop(user, loop, cycle, 'fail', r.terminal) };
	if (r.done) await audit(user, 'arm_wax_fill.run_parked', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, before: 'fail', message: r.read.message });
	return { pending: !r.done, loop: (await getLoop(loopId))! };
}

/** Fail route, part 2: the arm MOVES through the fail animation — only while the run is parked. */
export async function cycleFail(user: User, loopId: string): Promise<{ play: PlayResult; cycle: number }> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'fail');
	if (!cycle.skipSeq) throw new ArmWaxFillError('The skip instruction has not been sent yet — the gantry may still be over the stage.', 409);
	const robot = await loopRobot(loop);
	await assertArmMayMove(robot, loop, afterCartWant(cycle.index), 'play the fail animation');
	const p = await play(user, animRef(loop.failAnimation), 'fail');
	await patchCycle(loopId, cycle.index, { failArmRunId: p.runId });
	await audit(user, 'arm_wax_fill.cycle_fail', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, failedStep: cycle.failedStep ?? null, armRunId: p.runId, durationS: p.durationS });
	return { play: p, cycle: cycle.index };
}

/**
 * The fail animation ended: the cycle is failed and the loop ends — the fail
 * route always stops the run. `end` goes to the protocol (tip to the trash,
 * home); loopFinish then records the run's end.
 */
export async function cycleFailDone(user: User, loopId: string): Promise<LoopView> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'fail');
	const now = new Date();
	const failedStep = cycle.failedStep ?? 'scan';
	const msg = cycle.error ?? 'failed';
	await patchCycle(loopId, cycle.index, { step: 'failed', endedAt: now });
	await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { status: 'failed', error: `${failedStep}: ${msg} The fail animation played.`, endedAt: now } });
	const robot = await loopRobot(loop);
	const endNote = await sendEnd(user, loop, robot, cycle.index);
	if (endNote) await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { error: `${failedStep}: ${msg} The fail animation played. ${endNote}` } });
	await audit(user, 'arm_wax_fill.loop_failed', 'arm_wax_fill_runs', loopId, {
		cycle: cycle.index,
		step: failedStep,
		error: msg,
		failRoute: true,
		failArmRunId: cycle.failArmRunId ?? null,
		completedRuns: Number(loop.completedRuns ?? 0),
		endSent: !endNote
	});
	return (await getLoop(loopId))!;
}

/**
 * Put the scanned cart on the cycle's wax run the way the wax wizard's
 * loadDeck does for a deck: it must exist at `backing` (or be synthesised in
 * test mode), it is drawn out of its backed bucket pass, and it goes to
 * `wax_filling` pointing at the run — which is what the finish's
 * advanceCartsToWaxFilled looks for.
 */
async function attachCart(user: User, loop: any, waxRunId: string, barcode: string, testMode: boolean, cartPosition: number) {
	const cart = (await CartridgeRecord.findById(barcode).select('_id status waxFilling.runId backing.synthetic').lean()) as any;
	const now = new Date();
	if (!cart) {
		if (!testMode) {
			throw new ArmWaxFillError(
				`Cartridge ${barcode} is not in the system. A cart exists once it is scanned into a production bucket; or turn on test mode in Setup to synthesise test carts.`
			);
		}
		const labels = await findBucketLabels([barcode]);
		if (labels.size > 0) throw new ArmWaxFillError(`${barcode} is the label on bucket ${[...labels.values()][0]}, not a cartridge.`, 409);
		await CartridgeRecord.updateOne(
			{ _id: barcode },
			{ $setOnInsert: { _id: barcode, status: 'backing', 'backing.operator': opRef(user), 'backing.recordedAt': now, 'backing.synthetic': true } },
			{ upsert: true }
		);
		await audit(user, 'arm_wax_fill.synthetic_cart', 'cartridge_records', barcode, { loopId: String(loop._id), waxRunId, testMode: true });
	} else if (cart.status === 'wax_filling' && cart.waxFilling?.runId === waxRunId) {
		return; // a retry of this very cycle
	} else if (cart.status !== 'backing') {
		throw new ArmWaxFillError(`Cartridge ${barcode} is at "${cart.status ?? '(none)'}" — only backed carts (status backing) can be wax filled.`, 409);
	}
	const cycles = (await BucketCycle.find({ status: 'open', cartridgeIds: barcode }).select('_id bucketId cycleNumber').lean()) as any[];
	for (const cyc of cycles) {
		try {
			await consumeCarts({ cycleId: String(cyc._id), barcodes: [barcode], waxRunId, user: opRef(user) });
		} catch (e) {
			if (e instanceof BucketError) throw new ArmWaxFillError(`Bucket ${cyc.bucketId} #${cyc.cycleNumber}: ${e.message}`, e.status);
			throw e;
		}
	}
	await CartridgeRecord.updateOne(
		{ _id: barcode },
		{
			$set: {
				status: 'wax_filling',
				'waxFilling.runId': waxRunId,
				'waxFilling.robotId': loop.robot?._id ?? null,
				'waxFilling.robotName': loop.robot?.name ?? null,
				'waxFilling.deckPosition': cartPosition,
				'waxFilling.operator': opRef(user)
			}
		}
	);
}

/** The loop's run start never reached the robot: free the wax run again (no cart is on it yet). */
async function revertUnstartedWaxRun(user: User, waxRunId: string, reason: string) {
	const run = (await WaxFillingRun.findById(waxRunId).select('status opentronsRunId').lean()) as any;
	if (!run || run.opentronsRunId) return;
	await WaxFillingRun.updateOne({ _id: waxRunId }, { $set: { status: 'aborted', abortReason: reason, runEndTime: new Date() } });
	await audit(user, 'arm_wax_fill.wax_run_reverted', 'wax_filling_runs', waxRunId, { reason });
}

/**
 * Every param_* the form carries must sit inside the min/max the robot's
 * protocol schema declares for it. The OT-2 does not refuse an out-of-range
 * run-time parameter cleanly: POST /runs dies with a bare 500 "unhandled
 * errors in a TaskGroup" (2026-10-30: the taught scan Z of 200.1 against a
 * 200.0 maximum). Say which value and which bound instead.
 */
async function assertFormWithinSchema(robotId: string, form: FormData): Promise<void> {
	const entry = await currentProtocolEntry(robotId, 'wax-filling').catch(() => null);
	const schema = ((entry?.parametersSchema ?? []) as any[]).filter((p) => p && typeof p.variableName === 'string');
	const problems: string[] = [];
	for (const def of schema) {
		if (def.type !== 'int' && def.type !== 'float') continue;
		const raw = form.get(`param_${def.variableName}`);
		if (raw === null) continue;
		const v = Number(raw.toString());
		if (!Number.isFinite(v)) {
			problems.push(`${def.variableName} = "${raw}" is not a number`);
			continue;
		}
		const min = Number(def.min);
		const max = Number(def.max);
		if ((Number.isFinite(min) && v < min) || (Number.isFinite(max) && v > max)) {
			problems.push(`${def.variableName} = ${v} is outside the protocol's ${Number.isFinite(min) ? min : '…'}–${Number.isFinite(max) ? max : '…'} range`);
		}
	}
	if (problems.length) {
		throw new ArmWaxFillError(
			`The run was not started: ${problems.join('; ')}. Either re-teach that value on the Stage Calibration tab or deploy the current stage .py (its limits may be wider than the one on the robot).`,
			409
		);
	}
}

/**
 * The run-time parameters of the loop's one run: the taught, tip-neutral cart
 * location, the stage rotation, the dispense depth, the per-hole corrections,
 * the taught scan position (arm_scan_x/y/z) and how many carts the run serves
 * (cartridges). computeRunParameters only reads the RTPs the robot's schema
 * declares, so nothing else is sent.
 */
function loopRunForm(waxRunId: string, protocol: ProtocolView, calibration: CalibrationView, requestedRuns: number): FormData {
	const form = new FormData();
	form.set('runId', waxRunId);
	form.set('opentronsProtocolId', protocol.opentronsProtocolId);
	const cl = calibration.cartLocation!;
	form.set('param_arm_cart_x', String(cl.x));
	form.set('param_arm_cart_y', String(cl.y));
	form.set('param_arm_cart_z', String(cl.z));
	form.set('param_arm_cart_rotation_deg', String(calibration.stageRotationDeg));
	form.set('param_dispense_depth', String(calibration.dispenseDepth!.mm));
	for (const h of calibration.holes ?? []) {
		const p = holeOffsetParamNames(h.index);
		form.set(`param_${p.dx}`, String(h.offset.dx));
		form.set(`param_${p.dy}`, String(h.offset.dy));
		form.set(`param_${p.dz}`, String(h.offset.dz));
	}
	const sp = calibration.scanPosition!;
	form.set('param_arm_scan_x', String(sp.x));
	form.set('param_arm_scan_y', String(sp.y));
	form.set('param_arm_scan_z', String(sp.z));
	form.set('param_cartridges', String(requestedRuns));
	return form;
}

/**
 * Step 4: the arm MOVES through the withdraw animation — only while the run is
 * parked for the next cart. On the loop's last cart `end` goes out first, so
 * the protocol's tip-to-trash and home overlap the withdraw (the trash and
 * home are neither the calibrator nor the stage).
 */
export async function cycleWithdraw(user: User, loopId: string): Promise<{ play: PlayResult; cycle: number; endSent: boolean; endNote: string | null }> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'withdraw');
	const robot = await loopRobot(loop);
	const last = Number(loop.completedRuns ?? 0) + 1 >= Number(loop.requestedRuns) || !!loop.stopRequested;
	let endNote: string | null = null;
	if (last) {
		// `end` is an instruction + resume, which needs the run PAUSED: wait for the
		// park (a few seconds after CLEAR), send it, then the withdraw overlaps the
		// protocol's tip-to-trash and home.
		const w = await awaitPause(user, loop, robot, { kind: 'PARKED', cart: cycle.index + 1 });
		if (!w.done && w.terminal) throw new ArmWaxFillError(`The OT-2 run ended ${w.terminal} before the last cart's park — the arm will not withdraw. Press STOP RUN.`, 409);
		endNote = await sendEnd(user, loop, robot, cycle.index);
	} else {
		await assertArmMayMove(robot, loop, afterCartWant(cycle.index), 'withdraw');
	}
	const p = await play(user, animRef(loop.withdrawAnimation), 'withdraw');
	await patchCycle(loopId, cycle.index, { withdrawArmRunId: p.runId });
	await audit(user, 'arm_wax_fill.cycle_withdraw', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, armRunId: p.runId, durationS: p.durationS, last, endSent: last && !endNote });
	return { play: p, cycle: cycle.index, endSent: last && !endNote, endNote };
}

/** The withdraw play ended: the cycle is done; the next one starts, or the loop ends and the run is finishing. */
export async function cycleWithdrawDone(user: User, loopId: string): Promise<{ loop: LoopView; next: boolean }> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'withdraw');
	const now = new Date();
	const completedRuns = Number(loop.completedRuns ?? 0) + 1;
	await patchCycle(loopId, cycle.index, { step: 'done', endedAt: now });
	const finished = completedRuns >= Number(loop.requestedRuns);
	if (finished || loop.stopRequested) {
		await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { completedRuns, status: finished ? 'completed' : 'stopped', endedAt: now } });
		// Stop requested during this withdraw: the end has not gone out yet.
		if (!loop.ending) {
			const robot = await loopRobot(loop);
			const endNote = await sendEnd(user, loop, robot, cycle.index);
			if (endNote) await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { error: endNote } });
		}
		await audit(user, finished ? 'arm_wax_fill.loop_complete' : 'arm_wax_fill.loop_stopped', 'arm_wax_fill_runs', loopId, { completedRuns, requestedRuns: loop.requestedRuns });
		return { loop: (await getLoop(loopId))!, next: false };
	}
	await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { completedRuns }, $push: { cycles: { index: cycle.index + 1, step: 'grab', startedAt: now } } });
	return { loop: (await getLoop(loopId))!, next: true };
}

/**
 * After `end`: wait for the run to finish (tip to the trash, home) and record
 * its end on the wax run — a succeeded run advances the carts it filled to
 * wax_filled and completes (rehearsal runs advance nothing). Works whatever
 * the loop's final status. Bounded; `done` false means call again.
 */
export async function loopFinish(user: User, loopId: string): Promise<{ done: boolean; status: string | null; loop: LoopView }> {
	await connectDB();
	const loop = (await ArmWaxFillRun.findById(loopId).lean()) as any;
	if (!loop) throw new ArmWaxFillError('Loop not found.', 404);
	if (loop.runFinished) return { done: true, status: loop.opentronsRunFinalStatus ?? null, loop: loopView(loop) };
	if (!loop.ending) throw new ArmWaxFillError('The loop has not sent its end instruction yet.', 409);
	if (!loop.opentronsRunId) {
		await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { runFinished: true } });
		return { done: true, status: null, loop: (await getLoop(loopId))! };
	}
	const robot = await loopRobot(loop);
	const deadline = Date.now() + AWAIT_BUDGET_MS;
	let status: string | null = null;
	for (;;) {
		const r = await readRunPause(robot, String(loop.opentronsRunId));
		if (OT2_RUN_TERMINAL.has(r.status)) {
			status = r.status;
			break;
		}
		if (r.pause?.kind === 'NO_INSTRUCTION') {
			// Resumed from outside before the end record landed: send it again.
			await writeInstruction(user, loop, robot, 'end', r.pause.cart, null);
			await resumeRun(robot, String(loop.opentronsRunId));
		}
		if (Date.now() >= deadline) return { done: false, status: null, loop: (await getLoop(loopId))! };
		await waitMs(AWAIT_POLL_MS);
	}
	let note = '';
	let advanced: number | null = null;
	if (loop.waxRunId) {
		const fin = await recordRunFinishedQueue('wax', String(loop.waxRunId), status, user).catch((e) => ({ fail: { status: 500, error: (e as Error).message } }));
		if (isActionFail(fin)) note += ` The wax run's end could not be recorded (${fin.fail.error}).`;
		else advanced = (fin as any).advanced ?? null;
		if (status !== 'succeeded') {
			const stop = await stopRunQueue('wax', 'cancel', String(loop.waxRunId), { reason: `Robot-arm wax fill: robot run ended ${status} after the last cart` }, user).catch((e) => ({
				fail: { status: 500, error: (e as Error).message }
			}));
			if (isActionFail(stop)) note += ` The wax run could not be cancelled automatically (${stop.fail.error}) — cancel it on the Robots page.`;
		}
	}
	const set: Record<string, unknown> = { runFinished: true, opentronsRunFinalStatus: status };
	if (status !== 'succeeded' || note) set.error = [loop.error, status !== 'succeeded' ? `The robot run ended ${status} after the last cart.` : '', note.trim()].filter(Boolean).join(' ');
	await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: set });
	await audit(user, 'arm_wax_fill.loop_run_finished', 'arm_wax_fill_runs', loopId, { status, waxRunId: loop.waxRunId ?? null, opentronsRunId: loop.opentronsRunId, advanced, loopStatus: loop.status });
	return { done: true, status, loop: (await getLoop(loopId))! };
}

/**
 * Stop. While the OT-2 is filling, the fill and the withdraw still run (a
 * half-filled cart is worse than one more cycle) and the loop ends after them
 * — `end` goes out before that withdraw. At any other step the loop ends now:
 * the arm's play is stopped where it is if it is moving, and `end` is sent so
 * the protocol trashes its tip and homes (allowed beside a stopped or moving
 * arm: the trash and home are neither the calibrator nor the stage).
 */
export async function stopLoop(user: User, loopId: string): Promise<{ loop: LoopView; stoppedArm: boolean; torqueOn: boolean | null; endSent: boolean; note: string | null }> {
	const { loop, cycle } = await runningLoop(loopId);
	await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { stopRequested: true } });
	let stoppedArm = false;
	let torqueOn: boolean | null = null;
	let endSent = false;
	let note: string | null = null;
	if (['grab', 'scan', 'decide', 'fail', 'withdraw'].includes(cycle.step)) {
		if (cycle.step !== 'scan' && cycle.step !== 'decide') {
			const active = await playbackActive().catch(() => null);
			if (active) {
				const s = await stopPlayback(user);
				stoppedArm = true;
				torqueOn = s.torqueOn;
			}
		}
		await patchCycle(loopId, cycle.index, { step: 'stopped', endedAt: new Date() });
		await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { status: 'stopped', endedAt: new Date() } });
		if (!loop.ending && loop.opentronsRunId) {
			const robot = await getRobot(String(loop.robot?._id ?? '')).catch(() => null);
			note = robot ? await sendEnd(user, loop, robot, cycle.index) : 'The OT-2 is not registered — the robot run was left as it is.';
			endSent = !note;
			if (note) await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { error: note } });
		}
	}
	await audit(user, 'arm_wax_fill.stop', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, step: cycle.step, stoppedArm, torqueOn, endSent, note });
	return { loop: (await getLoop(loopId))!, stoppedArm, torqueOn, endSent, note };
}

/**
 * Force reset (the Robots board's "Reset" for this line). Ends the running
 * loop NOW whatever step it is at — the arm's play is stopped if it is moving
 * — so the page can then force the OT-2 back to idle over the ordinary
 * /force-reset route (which aborts the one-cart WaxFillingRun and clears the
 * robot's own run). Nothing to end is not an error: the OT-2 side still runs.
 */
export async function resetLoop(user: User): Promise<{ loop: LoopView | null; stoppedArm: boolean; torqueOn: boolean | null }> {
	await connectDB();
	const d = (await ArmWaxFillRun.findOne({ status: 'running' }).sort({ createdAt: -1 }).lean()) as any;
	let stoppedArm = false;
	let torqueOn: boolean | null = null;
	const active = await playbackActive().catch(() => null);
	if (active) {
		const s = await stopPlayback(user);
		stoppedArm = true;
		torqueOn = s.torqueOn;
	}
	if (!d) return { loop: null, stoppedArm, torqueOn };
	const loopId = String(d._id);
	const cycle = d.cycles?.[d.cycles.length - 1];
	const now = new Date();
	if (cycle && !['done', 'failed', 'stopped'].includes(cycle.step)) {
		await patchCycle(loopId, cycle.index, { step: 'stopped', error: 'force reset to idle', endedAt: now });
	}
	await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { status: 'stopped', stopRequested: true, error: 'force reset to idle', endedAt: now } });
	await audit(user, 'arm_wax_fill.force_reset', 'arm_wax_fill_runs', loopId, { cycle: cycle?.index ?? null, step: cycle?.step ?? null, stoppedArm, torqueOn });
	return { loop: await getLoop(loopId), stoppedArm, torqueOn };
}

// ── STOP RUN: halt now, then everything home ─────────────────────────────

/** An OT-2 run in one of these states is over; anything else is still moving or about to. */
const OT2_RUN_TERMINAL = new Set(['succeeded', 'failed', 'stopped']);

const HALT_REASON = 'Stop run: halted by the operator';

/** The robot's current protocol run (links.current) and its status, or null when the engine holds none. */
async function currentRobotRun(robot: any): Promise<{ id: string; status: string | null } | null> {
	const res = await robotGet(robot, '/runs');
	if (!res.ok) throw new Error(`the OT-2 did not list its runs (HTTP ${res.status})`);
	const body: any = await res.json().catch(() => ({}));
	const href = String(body?.links?.current?.href ?? '');
	const id = href ? href.split('/').pop() ?? '' : '';
	if (!id) return null;
	const run = (Array.isArray(body?.data) ? body.data : []).find((r: any) => r?.id === id);
	return { id, status: run?.status ? String(run.status) : null };
}

/** The open maintenance run's id (the scanner sweep moves the gantry in one), or null. */
async function currentMaintenanceRun(robot: any): Promise<string | null> {
	const res = await robotGet(robot, '/maintenance_runs/current_run').catch(() => null);
	if (!res || !res.ok) return null;
	const body: any = await res.json().catch(() => ({}));
	return body?.data?.id ? String(body.data.id) : null;
}

/**
 * Stop whatever the OT-2 is doing for this line that is not the fill (which
 * goes through the wax run's own cancel): the scan's sweep (cancelled on its
 * record so the bridge daemon stops its walk and closes its maintenance run)
 * and any protocol run the engine still holds. Best effort, never throws —
 * the loop ends either way and haltHomeGantry checks the robot again.
 */
async function haltRobotWork(user: User, loopId: string, robotId: string): Promise<string[]> {
	const notes: string[] = [];
	const now = new Date();
	const sweep = await OpentronsScannerSweepRun.findOneAndUpdate(
		{ contextRef: loopId, status: { $in: ['running', 'paused'] } },
		{
			$set: { cancelRequested: true, pauseRequested: false, status: 'cancelled', completedAt: now, abortReason: HALT_REASON },
			$push: { log: { ts: now, level: 'warn', message: `Cancelled by ${user.username}: Stop run pressed on the arm wax-fill page.` } }
		},
		{ new: true }
	)
		.lean()
		.catch(() => null);
	if (sweep) {
		notes.push(`scan sweep ${String((sweep as any)._id).slice(0, 8)} cancelled`);
		if ((sweep as any).line !== 'tailnet') {
			await Ot2BridgeCommand.updateMany(
				{ kind: 'sweep', status: { $in: ['pending', 'claimed'] }, 'payload.sweepRunId': String((sweep as any)._id) },
				{ $set: { status: 'expired', error: HALT_REASON, completedAt: now } }
			).catch(() => null);
		}
	}
	const robot = await getRobot(robotId).catch(() => null);
	if (!robot) {
		notes.push('the OT-2 is not registered — nothing stopped on it');
		return notes;
	}
	try {
		const cur = await currentRobotRun(robot);
		if (cur && !(cur.status && OT2_RUN_TERMINAL.has(cur.status))) {
			const res = await robotPost(robot, `/runs/${cur.id}/actions`, { data: { actionType: 'stop' } });
			notes.push(res.ok ? `stop sent to robot run ${cur.id.slice(0, 8)}` : `the OT-2 refused to stop run ${cur.id.slice(0, 8)} (HTTP ${res.status})`);
		}
	} catch (e) {
		notes.push(`the OT-2 could not be reached (${e instanceof Error ? e.message : String(e)})`);
	}
	return notes;
}

export interface HaltResult {
	loop: LoopView;
	/** The arm was moving and its play was stopped where it stood. */
	stoppedArm: boolean;
	torqueOn: boolean | null;
	/** What happened on the OT-2 side, for the page's log. */
	robotNotes: string[];
}

/**
 * STOP RUN. Halt everything NOW, whatever the step — unlike stopLoop, which
 * lets a fill and its withdraw finish. The arm's play is stopped where it is
 * (torque back on, so it holds); a fill in progress is cancelled through the
 * wax run's ordinary stop (the robot run is stopped, the cart goes back to
 * backed — the robot log decides if it was finished); a scan's sweep is
 * cancelled; and the loop ends stopped. The page then homes the OT-2
 * (haltHomeGantry) and only after the robot confirms it is home runs the arm's
 * Return to home — the arm never moves over the stage before the OT-2 is up.
 */
export async function haltLoop(user: User, loopId: string): Promise<HaltResult> {
	const { loop, cycle } = await runningLoop(loopId);
	await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { stopRequested: true } });
	let stoppedArm = false;
	let torqueOn: boolean | null = null;
	const active = await playbackActive().catch(() => null);
	if (active) {
		const s = await stopPlayback(user);
		stoppedArm = true;
		torqueOn = s.torqueOn;
	}
	const robotId = String(loop.robot?._id ?? '');
	let robotNotes: string[] = [];
	if (loop.waxRunId && !loop.runFinished) {
		// ARM-WAX-LOOP-B: the loop's ONE run, whatever step the cycle is at — the cancel
		// stops the robot run, records its end and (the robot log deciding) settles the
		// carts on it; the cart being filled goes back to backed.
		const stop = await stopRunQueue('wax', 'cancel', String(loop.waxRunId), { reason: HALT_REASON }, user).catch((e) => ({
			fail: { status: 500, error: (e as Error).message }
		}));
		robotNotes.push(
			isActionFail(stop)
				? `the wax run could not be cancelled (${stop.fail.error}) — cancel it on the Robots page`
				: `the wax run was cancelled${cycle.step === 'fill' && cycle.barcode ? ` and cart ${cycle.barcode} went back to backed` : ''}`
		);
		await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { ending: true, runFinished: true, opentronsRunFinalStatus: 'stopped' } });
	} else {
		robotNotes = await haltRobotWork(user, loopId, robotId);
	}
	const now = new Date();
	await patchCycle(loopId, cycle.index, { step: 'stopped', error: HALT_REASON, endedAt: now });
	await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { status: 'stopped', error: HALT_REASON, endedAt: now } });
	await audit(user, 'arm_wax_fill.halt', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, step: cycle.step, stoppedArm, torqueOn, robotNotes });
	return { loop: (await getLoop(loopId))!, stoppedArm, torqueOn, robotNotes };
}

/** How long haltHomeGantry waits for the OT-2 to finish stopping before it refuses. */
const HALT_SETTLE_MS = 30_000;

/**
 * After a halt: bring the OT-2 all the way home (every axis). Waits for the
 * run it was stopping to reach a terminal state (an engine mid-stop refuses a
 * home), closes a maintenance run the sweep daemon left open, then the
 * synchronous legacy home. Refuses — the arm does not move — while the robot
 * is still stopping or cannot be reached; the page offers a retry. The
 * pipette keeps its tip.
 */
export async function haltHomeGantry(user: User, loopId: string): Promise<{ homedAt: string; waitedMs: number; notes: string[] }> {
	await connectDB();
	const d = (await ArmWaxFillRun.findById(loopId).select('status robot').lean()) as any;
	if (!d) throw new ArmWaxFillError('Loop not found.', 404);
	if (d.status === 'running') throw new ArmWaxFillError('The loop is still running — press Stop run first.', 409);
	const robotId = String(d.robot?._id ?? '');
	const robot = await getRobot(robotId).catch(() => null);
	if (!robot) throw new ArmWaxFillError('The OT-2 is not registered — it cannot be homed from here.', 409);
	const t0 = Date.now();
	const notes: string[] = [];
	let cur: { id: string; status: string | null } | null = null;
	let stopSent = false;
	for (;;) {
		try {
			cur = await currentRobotRun(robot);
		} catch (e) {
			throw new ArmWaxFillError(`The OT-2 could not be reached (${e instanceof Error ? e.message : String(e)}) — it was not homed and the arm will not move.`, 502);
		}
		if (!cur || (cur.status && OT2_RUN_TERMINAL.has(cur.status))) break;
		// A run still going (a fill whose start landed after the halt, or a stop the
		// halt could not send) is stopped here, once; then we wait for it to end.
		if (!stopSent && cur.status !== 'stop-requested' && cur.status !== 'finishing') {
			stopSent = true;
			const res = await robotPost(robot, `/runs/${cur.id}/actions`, { data: { actionType: 'stop' } }).catch(() => null);
			notes.push(res?.ok ? `stop sent to robot run ${cur.id.slice(0, 8)} (still ${cur.status ?? 'active'} after the halt)` : `the OT-2 refused to stop run ${cur.id.slice(0, 8)}`);
		}
		if (Date.now() - t0 > HALT_SETTLE_MS) {
			throw new ArmWaxFillError(`The OT-2 run ${cur.id.slice(0, 8)} is still ${cur.status ?? 'active'} — it has not finished stopping. Wait a moment and try again; the arm will not move until the OT-2 is home.`, 409);
		}
		await new Promise((r) => setTimeout(r, 1500));
	}
	const maint = await currentMaintenanceRun(robot);
	if (maint) {
		const res = await robotDelete(robot, `/maintenance_runs/${maint}`).catch(() => null);
		notes.push(res?.ok ? `closed maintenance run ${maint.slice(0, 8)} (the scan's)` : `maintenance run ${maint.slice(0, 8)} could not be closed`);
	}
	let res: Response;
	try {
		res = await robotPost(robot, '/robot/home', { target: 'robot' }, { timeoutMs: 80_000 });
	} catch (e) {
		throw new ArmWaxFillError(`The OT-2 could not home (${e instanceof Error ? e.message : String(e)}) — the arm will not move.`, 502);
	}
	if (!res.ok) {
		const body: any = await res.json().catch(() => ({}));
		const detail = body?.message ?? body?.errors?.[0]?.detail ?? body?.error ?? `HTTP ${res.status}`;
		throw new ArmWaxFillError(`The OT-2 refused to home (${detail}) — the arm will not move. If a run is still active on the robot, reset it first.`, 502);
	}
	const at = new Date();
	const waitedMs = Date.now() - t0;
	await audit(user, 'arm_wax_fill.halt_gantry_home', 'arm_wax_fill_runs', loopId, { robotId, waitedMs, lastRun: cur, notes });
	return { homedAt: at.toISOString(), waitedMs, notes };
}

/** A step failed in the browser (or here): the loop stops with the reason on the cycle. */
export async function failLoop(user: User, loopId: string, step: string, error: string, extra: Record<string, unknown> = {}): Promise<LoopView> {
	await connectDB();
	const loop = (await ArmWaxFillRun.findById(loopId).lean()) as any;
	if (!loop) throw new ArmWaxFillError('Loop not found.', 404);
	if (loop.status !== 'running') return loopView(loop);
	const cycle = loop.cycles?.[loop.cycles.length - 1];
	const msg = String(error ?? 'failed').slice(0, 2000);
	if (cycle) await patchCycle(loopId, cycle.index, { step: 'failed', error: msg, endedAt: new Date(), ...extra });
	await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { status: 'failed', error: `${step}: ${msg}`, endedAt: new Date() } });
	await audit(user, 'arm_wax_fill.loop_failed', 'arm_wax_fill_runs', loopId, { cycle: cycle?.index ?? null, step, error: msg });
	return (await getLoop(loopId))!;
}
