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
 * Collision rules: the arm never moves while the gantry may be out over the
 * stage. cycleHomeGantry homes the OT-2 (POST /robot/home, synchronous) and
 * stamps the cycle; cycleGrab / cycleWithdraw refuse to play without a fresh
 * stamp. The stage protocol also homes itself at the end of every fill;
 * before the withdraw, cycleHomeGantry verifies that home on the robot (run
 * succeeded, last motion command a full home) and only lifts Z instead of a
 * second full home — anything it cannot verify falls back to the full home.
 * The one-slot scanner sweep is told how long ago the grab's home was
 * (armLineGantryHomedAgoS) so the bridge daemon can skip its own. And
 * the OT-2 pipette goes ALL THE WAY UP (a Z-only home) before every move it
 * makes for this line — in the stage protocol, in the Stage Calibration
 * Studio and in the one-slot scanner sweep (liftBeforeMove) — because the arm
 * and its stage stand above anything the OT-2's motion planner knows about.
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
	TipCalibratorFixture,
	WaxFillingRun
} from '$lib/server/db';
import { checkRobotConflict } from '$lib/server/manufacturing/resource-locks';
import { getRobotsHealth, type RobotHealth } from '$lib/server/opentrons/health';
import { consumeCarts, findBucketLabels, BucketError } from '$lib/server/services/bucket-service';
import { currentProtocolEntry, recordResyncUpload } from '$lib/server/opentrons/protocol-freshness';
import { assembleProtocolUpload, getRobot, robotGet, robotPost, uploadAssembledProtocol } from '$lib/server/opentrons/proxy';
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
export const FAIL_ROUTE_STEPS = ['scan'] as const;
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
				gantryHomedForGrabAt: iso(c.gantryHomedForGrabAt),
				gantryHomedForWithdrawAt: iso(c.gantryHomedForWithdrawAt),
				gantryHomedForFailAt: iso(c.gantryHomedForFailAt),
				error: c.error ?? null
			})
		),
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
		rehearsal: declared.has(REHEARSAL_RTP) || /rehearsal/i.test(protocolName)
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
		.select('_id protocolName fileName fileContent deployments.robotId deployments.deployedAt deployments.deployedBy updatedAt')
		.sort({ updatedAt: -1 })
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
				lastDeployedBy: mine[0]?.deployedBy ?? null
			};
		});
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
		newData: { robotId, opentronsProtocolId: uploaded.opentronsProtocolId, analysisStatus, line: 'queue', from: 'arm-wax-fill', rehearsal },
		changedAt: new Date(),
		changedBy: user.username
	});

	if (analysisStatus !== 'completed') {
		throw new ArmWaxFillError(
			`${fileName} was uploaded to ${robot.name} but its analysis ${analysisStatus === 'failed' ? 'FAILED' : 'did not complete'}` +
				`${analysisErrors.length ? `: ${analysisErrors.join('; ')}` : ''}. The robot keeps its previous wax-filling protocol.`,
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
	if (settings.robotId && !calibration?.scanPosition) blocking.push('Calibration: teach the scan position.');
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
	if (settings.robotId) notes.push('Before every arm move (grab, withdraw and the fail animation) the OT-2 gantry is homed and the arm waits until the robot confirms it.');
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
	if (requestedRuns < 1 || requestedRuns > 500) throw new ArmWaxFillError('Number of runs must be 1–500.');
	const settings = await getSettings();
	const [calibration, protocol, active, robotConflict] = await Promise.all([
		getCalibration(settings.robotId),
		protocolFor(settings.robotId),
		activeLoop(),
		settings.robotId ? checkRobotConflict(settings.robotId) : Promise.resolve(null)
	]);
	const r = readiness(settings, calibration, protocol, active, robotConflict);
	if (r.blocking.length) throw new ArmWaxFillError(r.blocking.join(' '), 409);
	const robot = (await OpentronsRobot.findById(settings.robotId).select('_id name').lean()) as any;
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
		startedBy: opRef(user),
		startedAt: now
	});
	await audit(user, 'arm_wax_fill.loop_start', 'arm_wax_fill_runs', _id, {
		requestedRuns,
		robotId: String(robot._id),
		cartPosition: settings.cartPosition,
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

// ── OT-2 gantry home before every arm move ───────────────────────────────

/** A home is trusted for this long; older than that, the step homes again before the arm moves. */
const GANTRY_HOME_FRESH_MS = 15 * 60_000;

function assertGantryHomed(cycle: any, key: 'gantryHomedForGrabAt' | 'gantryHomedForWithdrawAt' | 'gantryHomedForFailAt', what: string) {
	const at = cycle?.[key] ? new Date(cycle[key]).getTime() : 0;
	if (!at || Date.now() - at > GANTRY_HOME_FRESH_MS) {
		throw new ArmWaxFillError(
			`The OT-2 gantry has not been homed for the ${what} (or that home is older than 15 minutes). ` +
				'The arm does not move until the robot confirms it is home — press Resume to home it and carry on.',
			409
		);
	}
}

/** Seconds after which an arm-line gantry home no longer counts as fresh for the scanner sweep. */
export const GANTRY_HOME_FRESH_S = 120;

/**
 * Seconds since this line homed the gantry for the loop's current cycle, for
 * the one-slot scanner sweep (/api/scanner/sweep). The bridge daemon homes
 * the gantry at the start of every sweep unless it knows of a fresh home, and
 * it cannot see the legacy POST /robot/home this line issues before the grab;
 * the gantry has not moved since (only the arm did). null when the loop is not
 * running, the cycle is not at its scan step, the robot differs or the stamp
 * is older than GANTRY_HOME_FRESH_S — the daemon then homes as before.
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

/** How the gantry-home stamp was obtained: a full home, or a verified end-of-run home plus a Z-only lift. */
export type GantryHomeVia = 'full_home' | 'verified_run_home_lift';

/**
 * Before the withdraw: did the fill's robot run end with the protocol's own
 * full home? The stage protocol homes as its last motion (comments follow),
 * so a second full home here only costs time. Reads the run (succeeded, which
 * mount carries the pipette) and the last page of its commands. Anything
 * missing or unexpected is a reason to fall back to the full home, not an
 * error — the caller still issues a motion either way.
 */
async function verifyRunEndedAtHome(robot: any, opentronsRunId: string): Promise<{ ok: true; mount: 'left' | 'right' } | { ok: false; why: string }> {
	const read = async (path: string): Promise<any> => {
		const r = await robotGet(robot, path);
		if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
		return r.json();
	};
	try {
		const run = (await read(`/runs/${opentronsRunId}`))?.data;
		if (run?.status !== 'succeeded') return { ok: false, why: `run status ${run?.status ?? 'unknown'}` };
		const mount = run?.pipettes?.[0]?.mount;
		if (mount !== 'left' && mount !== 'right') return { ok: false, why: 'run reports no pipette mount' };
		// Last page of commands: with no cursor the robot centres the page on the
		// most recently completed command; re-read from the end if that fell short.
		const PAGE = 20;
		let page = await read(`/runs/${opentronsRunId}/commands?pageLength=${PAGE}`);
		const total = Number(page?.meta?.totalLength ?? 0);
		const end = Number(page?.meta?.cursor ?? 0) + (Array.isArray(page?.data) ? page.data.length : 0);
		if (total > 0 && end < total) page = await read(`/runs/${opentronsRunId}/commands?cursor=${Math.max(0, total - PAGE)}&pageLength=${PAGE}`);
		const cmds: any[] = Array.isArray(page?.data) ? page.data : [];
		const last = [...cmds].reverse().find((c) => c?.commandType !== 'comment');
		if (!last) return { ok: false, why: 'no motion command found at the end of the run' };
		if (last.commandType !== 'home' || last.status !== 'succeeded') return { ok: false, why: `last motion command was ${last.commandType} (${last.status}), not a succeeded home` };
		if (Array.isArray(last.params?.axes) && last.params.axes.length) return { ok: false, why: `last home was limited to ${last.params.axes.join(', ')}` };
		return { ok: true, mount };
	} catch (e) {
		return { ok: false, why: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * The motion cycleHomeGantry issues. Before the grab (and anything else) a
 * full home (~20 s): the gantry's history since the last cycle is not this
 * line's to know. Before the withdraw the fill's protocol has just homed as
 * its last motion, so when the robot confirms that (verifyRunEndedAtHome)
 * only the pipette is homed again — target 'pipette', its carriage and
 * plunger axes, a few seconds — as the physical stamp. Anything the robot
 * cannot confirm falls back to the full home; the audit records which and why.
 */
async function gantryHomePlan(robot: any, before: string, cycle: any): Promise<{ via: GantryHomeVia; target: Record<string, unknown>; fallbackReason: string | null }> {
	const full = (fallbackReason: string | null) => ({ via: 'full_home' as GantryHomeVia, target: { target: 'robot' }, fallbackReason });
	if (before !== 'withdraw') return full(null);
	if (!cycle.opentronsRunId) return full('this cycle has no robot run id');
	const v = await verifyRunEndedAtHome(robot, String(cycle.opentronsRunId));
	return v.ok ? { via: 'verified_run_home_lift', target: { target: 'pipette', mount: v.mount }, fallbackReason: null } : full(v.why);
}

/**
 * Home the OT-2 gantry and stamp the cycle, BEFORE the arm plays the grab, the
 * withdraw or the fail animation. The robot's legacy POST /robot/home is
 * synchronous (it answers once all axes are home) and needs no maintenance
 * run, so it leaves whatever run the robot holds untouched. cycleGrab /
 * cycleWithdraw / cycleFail refuse to play the arm without a fresh stamp, so a
 * browser that skipped this step cannot swing the arm in over a gantry that is
 * still out on the deck (after a scan it is at the scan position). Which
 * motion — the full home or, before a verified withdraw, the pipette lift —
 * is gantryHomePlan's call; before the grab and the fail animation it is
 * always the full home.
 */
export async function cycleHomeGantry(
	user: User,
	loopId: string,
	rawBefore: unknown
): Promise<{ homedAt: string; cycle: number; before: 'grab' | 'withdraw' | 'fail'; via: GantryHomeVia; fallbackReason: string | null }> {
	const before = rawBefore === 'withdraw' ? 'withdraw' : rawBefore === 'grab' ? 'grab' : rawBefore === 'fail' ? 'fail' : null;
	if (!before) throw new ArmWaxFillError('before must be grab, withdraw or fail.');
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, before);
	if (before === 'grab' && loop.stopRequested) throw new ArmWaxFillError('Stop was requested — the loop ends here.', 409);
	const robotId = String(loop.robot?._id ?? '');
	const robot = await getRobot(robotId);
	if (!robot) throw new ArmWaxFillError('The OT-2 is not registered or not active — the arm will not move.', 409);
	const plan = await gantryHomePlan(robot, before, cycle);
	const verb = plan.via === 'full_home' ? 'home' : 'lift its pipette';
	let res: Response;
	try {
		res = await robotPost(robot, '/robot/home', plan.target, { timeoutMs: 90_000 });
	} catch (e) {
		throw new ArmWaxFillError(`The OT-2 could not ${verb} (${e instanceof Error ? e.message : String(e)}) — the arm will not move.`, 502);
	}
	if (!res.ok) {
		const body: any = await res.json().catch(() => ({}));
		const detail = body?.message ?? body?.errors?.[0]?.detail ?? body?.error ?? `HTTP ${res.status}`;
		throw new ArmWaxFillError(`The OT-2 refused to ${verb} (${detail}) — the arm will not move. If a run is still active on the robot, finish or reset it first.`, 502);
	}
	const at = new Date();
	const key = before === 'grab' ? 'gantryHomedForGrabAt' : before === 'withdraw' ? 'gantryHomedForWithdrawAt' : 'gantryHomedForFailAt';
	await patchCycle(loopId, cycle.index, { [key]: at });
	await audit(user, 'arm_wax_fill.gantry_home', 'arm_wax_fill_runs', loopId, {
		cycle: cycle.index,
		before,
		robotId,
		via: plan.via,
		...(plan.fallbackReason ? { fallbackReason: plan.fallbackReason } : {})
	});
	return { homedAt: at.toISOString(), cycle: cycle.index, before, via: plan.via, fallbackReason: plan.fallbackReason };
}

/** Step 1: the arm MOVES through the grab animation — only after the gantry reported home. */
export async function cycleGrab(user: User, loopId: string): Promise<{ play: PlayResult; cycle: number }> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'grab');
	if (loop.stopRequested) throw new ArmWaxFillError('Stop was requested — the loop ends here.', 409);
	assertGantryHomed(cycle, 'gantryHomedForGrabAt', 'grab');
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

/** Step 2 is the browser's /api/scanner/sweep over the one-slot set; this records its result. */
export async function cycleScanned(user: User, loopId: string, input: { sweepRunId: unknown; barcode: unknown }): Promise<LoopView> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'scan');
	const sweepRunId = String(input.sweepRunId ?? '').trim();
	const barcode = String(input.barcode ?? '').trim();
	if (!barcode) throw new ArmWaxFillError('The scan returned no barcode.');
	if (sweepRunId) {
		const sweep = (await OpentronsScannerSweepRun.findById(sweepRunId).select('robotId scans status').lean()) as any;
		if (!sweep) throw new ArmWaxFillError('Sweep run not found.', 404);
		if (String(sweep.robotId) !== String(loop.robot?._id)) throw new ArmWaxFillError('That sweep ran on a different robot.', 409);
		const seen = (sweep.scans ?? []).some((s: any) => s.barcode === barcode);
		if (!seen) throw new ArmWaxFillError('The sweep did not read that barcode.', 409);
	}
	// Read, but is it a cart that can be filled? If not, the fail route — not a
	// loop failure with the cart left on the stage.
	const problem = await cartScanProblem(barcode, (await getSettings()).testMode);
	if (problem) return enterFailRoute(user, loopId, cycle, 'scan', problem, { sweepRunId: sweepRunId || null, barcode });
	await patchCycle(loopId, cycle.index, { step: 'fill', sweepRunId: sweepRunId || null, barcode });
	await audit(user, 'arm_wax_fill.cycle_scan', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, sweepRunId, barcode });
	return (await getLoop(loopId))!;
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

// ── the fail route ────────────────────────────────────────────────────────

/** The cycle leaves the happy path: step 'fail' with the reason on it; the fail animation is next. */
async function enterFailRoute(user: User, loopId: string, cycle: any, failedStep: FailRouteStep, reason: string, extra: Record<string, unknown> = {}): Promise<LoopView> {
	const msg = String(reason ?? 'failed').slice(0, 2000);
	await patchCycle(loopId, cycle.index, { step: 'fail', failedStep, error: msg, ...extra });
	await audit(user, 'arm_wax_fill.cycle_fail_route', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, failedStep, error: msg, ...extra });
	return (await getLoop(loopId))!;
}

/** The scan read nothing (sweep errored / timed out / completed without a barcode): the fail route. */
export async function cycleScanFailed(user: User, loopId: string, input: { reason: unknown; sweepRunId: unknown }): Promise<LoopView> {
	const { cycle } = await runningLoop(loopId);
	expectStep(cycle, 'scan');
	const sweepRunId = String(input.sweepRunId ?? '').trim() || null;
	const reason = String(input.reason ?? '').trim() || 'the scan read nothing';
	return enterFailRoute(user, loopId, cycle, 'scan', reason, { sweepRunId });
}

/** Fail route: the arm MOVES through the fail animation — only after the gantry reported home. */
export async function cycleFail(user: User, loopId: string): Promise<{ play: PlayResult; cycle: number }> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'fail');
	assertGantryHomed(cycle, 'gantryHomedForFailAt', 'fail animation');
	const p = await play(user, animRef(loop.failAnimation), 'fail');
	await patchCycle(loopId, cycle.index, { failArmRunId: p.runId });
	await audit(user, 'arm_wax_fill.cycle_fail', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, failedStep: cycle.failedStep ?? null, armRunId: p.runId, durationS: p.durationS });
	return { play: p, cycle: cycle.index };
}

/** The fail animation ended: the cycle is failed and the loop ends — the fail route always stops the run. */
export async function cycleFailDone(user: User, loopId: string): Promise<LoopView> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'fail');
	const now = new Date();
	const failedStep = cycle.failedStep ?? 'scan';
	const msg = cycle.error ?? 'failed';
	await patchCycle(loopId, cycle.index, { step: 'failed', endedAt: now });
	await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { status: 'failed', error: `${failedStep}: ${msg} The fail animation played.`, endedAt: now } });
	await audit(user, 'arm_wax_fill.loop_failed', 'arm_wax_fill_runs', loopId, {
		cycle: cycle.index,
		step: failedStep,
		error: msg,
		failRoute: true,
		failArmRunId: cycle.failArmRunId ?? null,
		completedRuns: Number(loop.completedRuns ?? 0)
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

/** A start that never reached the robot: free the robot and the cart again. */
async function revertUnstartedWaxRun(user: User, waxRunId: string, barcode: string, reason: string) {
	const run = (await WaxFillingRun.findById(waxRunId).select('status opentronsRunId').lean()) as any;
	if (!run || run.opentronsRunId) return;
	await WaxFillingRun.updateOne({ _id: waxRunId }, { $set: { status: 'aborted', abortReason: reason, runEndTime: new Date() } });
	const cart = (await CartridgeRecord.findById(barcode).select('status waxFilling.runId backing.synthetic').lean()) as any;
	if (cart?.status === 'wax_filling' && cart.waxFilling?.runId === waxRunId) {
		if (cart.backing?.synthetic) await CartridgeRecord.deleteOne({ _id: barcode });
		else await CartridgeRecord.updateOne({ _id: barcode }, { $set: { status: 'backing' }, $unset: { waxFilling: '' } });
	}
	await audit(user, 'arm_wax_fill.wax_run_reverted', 'wax_filling_runs', waxRunId, { barcode, reason });
}

/**
 * Step 3: the OT-2 fills the cart. A WaxFillingRun for this one cart, then
 * the ordinary start (freshness gate, create, play) on the robot's current
 * wax-filling protocol. With the stage protocol the taught, tip-neutral cart
 * location goes in as arm_cart_x/y/z (+ the stage rotation); with the legacy
 * carriage protocol it is cartridges = 1 at the configured deck position. The
 * browser then watches the robot run (EmbeddedRunController) and reports
 * its end to cycleFillDone. A retry after a reload returns the run already
 * started for this cycle.
 */
export async function cycleFill(user: User, loopId: string): Promise<{ waxRunId: string; opentronsRunId: string; cycle: number }> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'fill');
	if (!cycle.barcode) throw new ArmWaxFillError('This cycle has no scanned barcode.', 409);
	if (cycle.waxRunId && cycle.opentronsRunId) return { waxRunId: cycle.waxRunId, opentronsRunId: cycle.opentronsRunId, cycle: cycle.index };

	const settings = await getSettings();
	const robotId = String(loop.robot?._id ?? '');
	const protocol = await protocolFor(robotId);
	if (!protocol) throw new ArmWaxFillError('The robot has no wax-filling protocol uploaded.', 409);
	const calibration = await getCalibration(robotId);
	const stage = protocol.declaresCartLocation;
	if (stage && !calibration?.cartLocation?.tipAdjust) {
		throw new ArmWaxFillError('The cart location is not taught tip-neutral (pick up a tip, calibrate it, then save it) — the stage protocol will not be started without it.', 409);
	}
	if (stage && !calibration?.dispenseDepth) {
		throw new ArmWaxFillError('The dispense depth is not taught (Stage calibration tab) — the stage protocol will not be started without it.', 409);
	}

	let waxRunId: string = cycle.waxRunId ?? '';
	if (!waxRunId) {
		const conflict = await checkRobotConflict(robotId);
		if (conflict) throw new ArmWaxFillError(`${conflict} — finish or cancel it on the Robots page, then press Resume.`, 409);
		waxRunId = generateId();
		await WaxFillingRun.create({
			_id: waxRunId,
			robot: { _id: robotId, name: loop.robot?.name ?? robotId },
			operator: opRef(user),
			status: 'Loading',
			// No deck: the single cart sits at a taught location the arm places it in (startContext accepts an armWaxFill run without one).
			waxSourceLot: settings.waxSourceLot ?? undefined,
			cartridgeIds: [],
			plannedCartridgeCount: 1,
			setupTimestamp: new Date(),
			armWaxFill: { loopId, cycleIndex: cycle.index, rehearsal: protocol.rehearsal },
			notes: [
				{
					_id: generateId(),
					body: protocol.rehearsal
						? `Robot-arm wax fill REHEARSAL (p300, air, nothing dispensed): cycle ${cycle.index} of loop ${loopId}, cart ${cycle.barcode} checked only — not on this run, not drawn from its bucket, not advanced.`
						: `Robot-arm wax fill: cycle ${cycle.index} of loop ${loopId}, one cart ${stage ? 'at the taught stage location' : `at deck position ${loop.cartPosition}`}.`,
					phase: 'wax_run',
					author: opRef(user),
					createdAt: new Date()
				}
			]
		});
		await audit(user, 'arm_wax_fill.wax_run_create', 'wax_filling_runs', waxRunId, { loopId, cycle: cycle.index, barcode: cycle.barcode });
		await patchCycle(loopId, cycle.index, { waxRunId });
	}
	try {
		if (protocol.rehearsal) {
			// REHEARSAL: the cart was checked at the scan (cartScanProblem — a backed cart,
			// else the fail route) and that is all that happens to it. It is not put on
			// the run, not drawn from its bucket and never advanced: the run dispenses air.
			await audit(user, 'arm_wax_fill.rehearsal_cart', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, waxRunId, barcode: cycle.barcode, touched: false });
		} else {
			await attachCart(user, loop, waxRunId, cycle.barcode, settings.testMode, loop.cartPosition);
			await WaxFillingRun.updateOne({ _id: waxRunId }, { $addToSet: { cartridgeIds: cycle.barcode } });
		}
	} catch (err) {
		await revertUnstartedWaxRun(user, waxRunId, cycle.barcode, `cart could not be attached: ${(err as Error).message}`).catch(() => null);
		await patchCycle(loopId, cycle.index, { waxRunId: null });
		throw err;
	}

	const form = new FormData();
	form.set('runId', waxRunId);
	form.set('opentronsProtocolId', protocol.opentronsProtocolId);
	if (stage) {
		// The stage protocol: the taught tip-neutral rim of the first wax hole and
		// how the stage turns the cart. (computeRunParameters only reads the RTPs
		// the robot's schema declares, so nothing else is sent.)
		const cl = calibration!.cartLocation!;
		form.set('param_arm_cart_x', String(cl.x));
		form.set('param_arm_cart_y', String(cl.y));
		form.set('param_arm_cart_z', String(cl.z));
		form.set('param_arm_cart_rotation_deg', String(calibration!.stageRotationDeg));
		form.set('param_dispense_depth', String(calibration!.dispenseDepth!.mm));
		// Per-hole corrections from the Stage Calibration Studio (only the RTPs the
		// robot's schema declares are read, so an older stage .py ignores them).
		for (const h of calibration!.holes ?? []) {
			const p = holeOffsetParamNames(h.index);
			form.set(`param_${p.dx}`, String(h.offset.dx));
			form.set(`param_${p.dy}`, String(h.offset.dy));
			form.set(`param_${p.dz}`, String(h.offset.dz));
		}
	} else {
		// Legacy carriage protocol: one cart at the configured deck position.
		form.set('param_cartridges', '1');
		form.set('param_resume_cartridge', String(loop.cartPosition));
		form.set('param_resume_hole', '1');
	}
	const r = await startRunQueue('wax', form, user);
	if (isActionFail(r)) {
		await revertUnstartedWaxRun(user, waxRunId, cycle.barcode, `start failed: ${r.fail.error}`).catch(() => null);
		await patchCycle(loopId, cycle.index, { waxRunId: null });
		throw new ArmWaxFillError(`Wax fill did not start: ${r.fail.error}`, r.fail.status);
	}
	await patchCycle(loopId, cycle.index, { opentronsRunId: r.opentronsRunId });
	await audit(user, 'arm_wax_fill.cycle_fill', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, waxRunId, opentronsRunId: r.opentronsRunId, barcode: cycle.barcode });
	return { waxRunId, opentronsRunId: r.opentronsRunId, cycle: cycle.index };
}

/**
 * The robot run ended. succeeded → the cart is wax_filled, the wax run
 * completes (robot released) and the cycle moves to withdraw. Anything else
 * → the wax run is cancelled through the ordinary stop (the robot log decides
 * whether the cart was finished) and the loop fails.
 */
export async function cycleFillDone(user: User, loopId: string, rawStatus: unknown): Promise<LoopView> {
	const { cycle } = await runningLoop(loopId);
	expectStep(cycle, 'fill');
	if (!cycle.waxRunId || !cycle.opentronsRunId) throw new ArmWaxFillError('This cycle has no robot run to finish.', 409);
	const finalStatus = String(rawStatus ?? '').toLowerCase();
	const fin = await recordRunFinishedQueue('wax', cycle.waxRunId, finalStatus, user);
	if (isActionFail(fin)) throw new ArmWaxFillError(`Could not record the wax run's end: ${fin.fail.error}`, fin.fail.status);
	if (finalStatus === 'succeeded') {
		await patchCycle(loopId, cycle.index, { step: 'withdraw', opentronsRunFinalStatus: finalStatus });
		await audit(user, 'arm_wax_fill.cycle_filled', 'arm_wax_fill_runs', loopId, {
			cycle: cycle.index,
			waxRunId: cycle.waxRunId,
			finalStatus,
			advanced: (fin as any).advanced ?? null
		});
		return (await getLoop(loopId))!;
	}
	let cancelNote = '';
	const stop = await stopRunQueue('wax', 'cancel', cycle.waxRunId, { reason: `Robot-arm wax fill: robot run ended ${finalStatus}` }, user).catch((e) => ({
		fail: { status: 500, error: (e as Error).message }
	}));
	if (isActionFail(stop)) cancelNote = ` The wax run could not be cancelled automatically (${stop.fail.error}) — cancel it on the Robots page.`;
	await failLoop(user, loopId, 'fill', `The robot run ended ${finalStatus}.${cancelNote}`, { opentronsRunFinalStatus: finalStatus });
	return (await getLoop(loopId))!;
}

/** Step 4: the arm MOVES through the withdraw animation — only after the gantry reported home. */
export async function cycleWithdraw(user: User, loopId: string): Promise<{ play: PlayResult; cycle: number }> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'withdraw');
	assertGantryHomed(cycle, 'gantryHomedForWithdrawAt', 'withdraw');
	const p = await play(user, animRef(loop.withdrawAnimation), 'withdraw');
	await patchCycle(loopId, cycle.index, { withdrawArmRunId: p.runId });
	await audit(user, 'arm_wax_fill.cycle_withdraw', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, armRunId: p.runId, durationS: p.durationS });
	return { play: p, cycle: cycle.index };
}

/** The withdraw play ended: the cycle is done; the next one starts, or the loop ends. */
export async function cycleWithdrawDone(user: User, loopId: string): Promise<{ loop: LoopView; next: boolean }> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'withdraw');
	const now = new Date();
	const completedRuns = Number(loop.completedRuns ?? 0) + 1;
	await patchCycle(loopId, cycle.index, { step: 'done', endedAt: now });
	const finished = completedRuns >= Number(loop.requestedRuns);
	if (finished || loop.stopRequested) {
		await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { completedRuns, status: finished ? 'completed' : 'stopped', endedAt: now } });
		await audit(user, finished ? 'arm_wax_fill.loop_complete' : 'arm_wax_fill.loop_stopped', 'arm_wax_fill_runs', loopId, { completedRuns, requestedRuns: loop.requestedRuns });
		return { loop: (await getLoop(loopId))!, next: false };
	}
	await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { completedRuns }, $push: { cycles: { index: cycle.index + 1, step: 'grab', startedAt: now } } });
	return { loop: (await getLoop(loopId))!, next: true };
}

/**
 * Stop. While the arm is moving (grab / withdraw / fail animation) the play is
 * stopped and the loop ends now; while the OT-2 is filling, the fill and the withdraw still
 * run (a half-filled cart is worse than one more cycle) and the loop ends
 * after them; between steps it ends at the next step.
 */
export async function stopLoop(user: User, loopId: string): Promise<{ loop: LoopView; stoppedArm: boolean; torqueOn: boolean | null }> {
	const { cycle } = await runningLoop(loopId);
	await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { stopRequested: true } });
	let stoppedArm = false;
	let torqueOn: boolean | null = null;
	if (cycle.step === 'grab' || cycle.step === 'withdraw' || cycle.step === 'scan' || cycle.step === 'fail') {
		if (cycle.step !== 'scan') {
			const active = await playbackActive().catch(() => null);
			if (active) {
				const s = await stopPlayback(user);
				stoppedArm = true;
				torqueOn = s.torqueOn;
			}
		}
		await patchCycle(loopId, cycle.index, { step: 'stopped', endedAt: new Date() });
		await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { status: 'stopped', endedAt: new Date() } });
	}
	await audit(user, 'arm_wax_fill.stop', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, step: cycle.step, stoppedArm, torqueOn });
	return { loop: (await getLoop(loopId))!, stoppedArm, torqueOn };
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
