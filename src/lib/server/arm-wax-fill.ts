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
 * Collision rule: the arm never moves while the gantry may be out over the
 * stage. cycleHomeGantry homes the OT-2 (POST /robot/home, synchronous) and
 * stamps the cycle; cycleGrab / cycleWithdraw refuse to play without a fresh
 * stamp. The stage protocol also homes itself at the end of every fill.
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
	OpentronsRobot,
	OpentronsScannerPositionSet,
	OpentronsScannerSweepRun,
	TipCalibratorFixture,
	WaxFillingRun
} from '$lib/server/db';
import { checkRobotConflict } from '$lib/server/manufacturing/resource-locks';
import { getRobotsHealth, type RobotHealth } from '$lib/server/opentrons/health';
import { consumeCarts, findBucketLabels, BucketError } from '$lib/server/services/bucket-service';
import { currentProtocolEntry } from '$lib/server/opentrons/protocol-freshness';
import { getRobot, robotPost } from '$lib/server/opentrons/proxy';
import { nextStudioTipWell } from '$lib/server/opentrons/tip-cursor';
import { TIP_PROFILE, plausibleZ, resolveCalibratorPoint } from '$lib/server/services/deck-calibration/tip-calibrator';
import {
	DISPENSE_DEPTH_LIMITS,
	HOLE_OFFSET_LIMIT_MM,
	STAGE_JUMP_DEFAULT_MM,
	STAGE_JUMP_LIMITS,
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
export async function saveAnimations(user: User, input: { grab: unknown; withdraw: unknown }): Promise<SettingsView> {
	await connectDB();
	const grab = await resolveAnimation(input.grab, 'grab');
	const withdraw = await resolveAnimation(input.withdraw, 'withdraw');
	const before = settingsView(await ArmWaxFillSettings.findById('default').lean());
	const now = new Date();
	await ArmWaxFillSettings.updateOne(
		{ _id: 'default' },
		{ $set: { grabAnimation: grab, withdrawAnimation: withdraw, animationsChangedAt: now, animationsChangedBy: opRef(user), updatedBy: opRef(user) } },
		{ upsert: true }
	);
	await audit(user, 'arm_wax_fill.animations', 'arm_wax_fill_settings', 'default', {
		grab,
		withdraw,
		before: { grab: before.grabAnimation, withdraw: before.withdrawAnimation }
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
	/** Travel clearance over the rim when arriving at / leaving the cart (stage_jump_height). */
	stageJumpHeightMm: number;
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
	const stageRotationDeg = Number.isFinite(Number(d?.stageRotationDeg)) ? Number(d.stageRotationDeg) : 0;
	const jump = Number(d?.stageJumpHeightMm);
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
		stageJumpHeightMm: Number.isFinite(jump) && jump >= STAGE_JUMP_LIMITS.min && jump <= STAGE_JUMP_LIMITS.max ? jump : STAGE_JUMP_DEFAULT_MM,
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
 *     are left alone — "Shift whole grid";
 *   • anything else           → each hole's correction grows by its delta, so the
 *     lattice stays where it was taught and only those holes move. Corrections
 *     are capped at HOLE_OFFSET_LIMIT_MM (the protocol's RTP bound); an edit
 *     that would exceed it is skipped and reported, never clamped.
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
		if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) > 10) throw new ArmWaxFillError(`Delta for ${wellName} is over 10 mm — that is not a correction.`);
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
	input: { x: unknown; y: unknown; z: unknown; zCalWax?: unknown; maxTipAdjust?: unknown }
): Promise<{ position: { x: number; y: number; z: number }; zCalWax: number; maxTipAdjust: number | null }> {
	await connectDB();
	if (!robotId) throw new ArmWaxFillError('Save the setup (robot) first.');
	const x = num(input.x, 'calX');
	const y = num(input.y, 'calY');
	const z = num(input.z, 'Approach Z');
	if (plausibleZ(z) === undefined) throw new ArmWaxFillError(`Approach Z must be between ${CAL_Z_LIMITS.min} and ${CAL_Z_LIMITS.max} mm.`);
	if (x < 1 || y < 1) throw new ArmWaxFillError('calX / calY look untaught (below 1 mm) — jog onto the fixture and use "From live".');
	const prev = (await TipCalibratorFixture.findOne({ robotId, deckKey: null }).lean()) as any;
	let zCalWax: number;
	if (input.zCalWax !== null && input.zCalWax !== undefined && String(input.zCalWax).trim() !== '') {
		const v = plausibleZ(Number(input.zCalWax));
		if (v === undefined) throw new ArmWaxFillError(`Probe Z must be between ${CAL_Z_LIMITS.min} and ${CAL_Z_LIMITS.max} mm.`);
		zCalWax = v;
	} else {
		zCalWax = plausibleZ(Number(prev?.zCalWax)) ?? TIP_PROFILE.wax.defaultZ;
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
			$set: { position: { x, y, z }, zCalWax, maxTipAdjust, capturedBy: opRef(user), capturedAt: now, deckLoadName: null },
			$setOnInsert: { _id: generateId(), robotId, deckKey: null, zCalReagent: TIP_PROFILE.reagent.defaultZ }
		},
		{ upsert: true }
	);
	await audit(user, 'arm_wax_fill.calibrator', 'tip_calibrator_fixtures', robotId, {
		position: { x, y, z },
		zCalWax,
		maxTipAdjust,
		before: prev ? { position: prev.position, zCalWax: prev.zCalWax, maxTipAdjust: prev.maxTipAdjust ?? null } : null
	});
	return { position: { x, y, z }, zCalWax, maxTipAdjust };
}

/** The cart's rotation on the stage and the travel clearance over the rim. */
export async function saveStageGeometry(user: User, robotId: string, input: { rotationDeg: unknown; jumpHeightMm: unknown }): Promise<CalibrationView> {
	await connectDB();
	if (!robotId) throw new ArmWaxFillError('Save the setup (robot) first.');
	const rotationDeg = input.rotationDeg === null || String(input.rotationDeg).trim() === '' ? 0 : num(input.rotationDeg, 'Cart rotation');
	if (rotationDeg < -360 || rotationDeg > 360) throw new ArmWaxFillError('Cart rotation must be between −360° and 360°.');
	const jumpHeightMm = input.jumpHeightMm === null || String(input.jumpHeightMm).trim() === '' ? STAGE_JUMP_DEFAULT_MM : num(input.jumpHeightMm, 'Travel height');
	if (jumpHeightMm < STAGE_JUMP_LIMITS.min || jumpHeightMm > STAGE_JUMP_LIMITS.max) {
		throw new ArmWaxFillError(`Travel height must be ${STAGE_JUMP_LIMITS.min}–${STAGE_JUMP_LIMITS.max} mm above the rim.`);
	}
	const prev = (await ArmWaxFillCalibration.findById(robotId).lean()) as any;
	await ArmWaxFillCalibration.updateOne(
		{ _id: robotId },
		{ $set: { stageRotationDeg: rotationDeg, stageJumpHeightMm: jumpHeightMm, updatedBy: opRef(user) } },
		{ upsert: true }
	);
	await audit(user, 'arm_wax_fill.stage_geometry', 'arm_wax_fill_calibrations', robotId, {
		rotationDeg,
		jumpHeightMm,
		before: { rotationDeg: prev?.stageRotationDeg ?? null, jumpHeightMm: prev?.stageJumpHeightMm ?? null }
	});
	return calibrationView(robotId, await ArmWaxFillCalibration.findById(robotId).lean());
}

// ── page load ────────────────────────────────────────────────────────────

export interface ProtocolView {
	opentronsProtocolId: string;
	protocolName: string;
	/** The protocol declares arm_cart_x/y/z, so the taught cart location is sent to it. */
	declaresCartLocation: boolean;
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
	/** When the OT-2 confirmed its gantry home before each arm move (cycleHomeGantry). */
	gantryHomedForGrabAt: string | null;
	gantryHomedForWithdrawAt: string | null;
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
				gantryHomedForGrabAt: iso(c.gantryHomedForGrabAt),
				gantryHomedForWithdrawAt: iso(c.gantryHomedForWithdrawAt),
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
	return {
		opentronsProtocolId: String(entry.opentronsProtocolId),
		protocolName: entry.protocolName ?? 'wax-filling',
		declaresCartLocation: CART_LOCATION_RTPS.every((k) => declared.has(k))
	};
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
		if (cl && !calibration?.dispenseDepth) blocking.push('Stage calibration: teach the dispense depth — jog the tip to the height it should dispense at over the first wax hole and save it.');
		if (cl?.tipAdjust && calibration?.dispenseDepth) {
			notes.push(
				`The stage protocol fills the taught cart location (tip-neutral; cart rotation ${calibration.stageRotationDeg}°), dispensing ` +
					`${Math.abs(calibration.dispenseDepth.mm)} mm ${calibration.dispenseDepth.mm >= 0 ? 'below' : 'above'} the rim, travelling ${calibration.stageJumpHeightMm} mm over it. No deck or deck position is used.`
			);
		}
	} else if (settings.robotId && protocol) {
		if (!calibration?.cartLocation) notes.push(`Cart location is not taught. The current protocol does not read it; it fills deck position ${settings.cartPosition} from the deck calibration.`);
		else notes.push(`The current protocol does not declare arm_cart_x/y/z, so the taught cart location is kept but not sent; it fills deck position ${settings.cartPosition}. Upload protocols/Wax_Filling_GEN7_ArmStage.py to fill the stage.`);
	}
	if (settings.robotId) notes.push('Before every arm move (grab and withdraw) the OT-2 gantry is homed and the arm waits until the robot confirms it.');
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
	tiprackLoadName: string;
	nextTipWell: string;
	nextTipSource: string;
	calibrator: { x: number; y: number; approachZ: number; probeZ: number; source: string; maxTipAdjust: number | null; taughtAt: string | null; taughtBy: string | null };
	/** Whether the robot's current wax-filling protocol declares the per-hole hole_NN_dx/dy/dz RTPs. */
	protocolDeclaresHoleOffsets: boolean;
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
					? protocol.protocolName
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
	const [robot, calibration, protocol, teach, active] = await Promise.all([
		robotId ? (OpentronsRobot.findById(robotId).select('_id name').lean() as Promise<any>) : Promise.resolve(null),
		getCalibration(robotId),
		protocolFor(robotId).catch(() => null),
		robotId ? teachAid(robotId).catch((): TeachAid | null => null) : Promise.resolve<TeachAid | null>(null),
		activeLoop()
	]);
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

async function teachAid(robotId: string): Promise<TeachAid> {
	const [cal, tip, entry] = await Promise.all([
		resolveCalibratorPoint(robotId, 'wax', {}),
		nextStudioTipWell(robotId, 'wax'),
		currentProtocolEntry(robotId, 'wax-filling').catch(() => null)
	]);
	const declared = new Set(((entry?.parametersSchema ?? []) as any[]).map((p) => p?.variableName));
	return {
		tiprackLoadName: TIP_PROFILE.wax.loadName,
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
	const [robots, moveSets, sequences, calibration, protocol, active, recent, robotConflict, teach] = await Promise.all([
		OpentronsRobot.find({ isActive: { $ne: false } }).select('_id name').sort({ name: 1 }).lean(),
		listMoveSets().catch(() => []),
		listSequences().catch(() => []),
		getCalibration(settings.robotId),
		protocolFor(settings.robotId).catch(() => null),
		activeLoop(),
		ArmWaxFillRun.find({ status: { $ne: 'running' } }).sort({ createdAt: -1 }).limit(8).lean(),
		settings.robotId ? checkRobotConflict(settings.robotId).catch(() => null) : Promise.resolve(null),
		settings.robotId ? teachAid(settings.robotId).catch((): TeachAid | null => null) : Promise.resolve<TeachAid | null>(null)
	]);
	const robotName = (robots as any[]).find((r) => String(r._id) === settings.robotId)?.name ?? null;
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
		cycles: [{ index: 1, step: 'grab', startedAt: now }],
		startedBy: opRef(user),
		startedAt: now
	});
	await audit(user, 'arm_wax_fill.loop_start', 'arm_wax_fill_runs', _id, {
		requestedRuns,
		robotId: String(robot._id),
		cartPosition: settings.cartPosition,
		grab: settings.grabAnimation,
		withdraw: settings.withdrawAnimation
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

function assertGantryHomed(cycle: any, key: 'gantryHomedForGrabAt' | 'gantryHomedForWithdrawAt', what: string) {
	const at = cycle?.[key] ? new Date(cycle[key]).getTime() : 0;
	if (!at || Date.now() - at > GANTRY_HOME_FRESH_MS) {
		throw new ArmWaxFillError(
			`The OT-2 gantry has not been homed for the ${what} (or that home is older than 15 minutes). ` +
				'The arm does not move until the robot confirms it is home — press Resume to home it and carry on.',
			409
		);
	}
}

/**
 * Home the OT-2 gantry and stamp the cycle, BEFORE the arm plays the grab or
 * the withdraw. The robot's legacy POST /robot/home is synchronous (it answers
 * once all axes are home) and needs no maintenance run, so it leaves whatever
 * run the robot holds untouched. cycleGrab / cycleWithdraw refuse to play the
 * arm without a fresh stamp, so a browser that skipped this step cannot swing
 * the arm in over a gantry that is still out on the deck.
 */
export async function cycleHomeGantry(user: User, loopId: string, rawBefore: unknown): Promise<{ homedAt: string; cycle: number; before: 'grab' | 'withdraw' }> {
	const before = rawBefore === 'withdraw' ? 'withdraw' : rawBefore === 'grab' ? 'grab' : null;
	if (!before) throw new ArmWaxFillError('before must be grab or withdraw.');
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, before);
	if (before === 'grab' && loop.stopRequested) throw new ArmWaxFillError('Stop was requested — the loop ends here.', 409);
	const robotId = String(loop.robot?._id ?? '');
	const robot = await getRobot(robotId);
	if (!robot) throw new ArmWaxFillError('The OT-2 is not registered or not active — the arm will not move.', 409);
	let res: Response;
	try {
		res = await robotPost(robot, '/robot/home', { target: 'robot' }, { timeoutMs: 90_000 });
	} catch (e) {
		throw new ArmWaxFillError(`The OT-2 could not be homed (${e instanceof Error ? e.message : String(e)}) — the arm will not move.`, 502);
	}
	if (!res.ok) {
		const body: any = await res.json().catch(() => ({}));
		const detail = body?.message ?? body?.errors?.[0]?.detail ?? body?.error ?? `HTTP ${res.status}`;
		throw new ArmWaxFillError(`The OT-2 refused to home (${detail}) — the arm will not move. If a run is still active on the robot, finish or reset it first.`, 502);
	}
	const at = new Date();
	const key = before === 'grab' ? 'gantryHomedForGrabAt' : 'gantryHomedForWithdrawAt';
	await patchCycle(loopId, cycle.index, { [key]: at });
	await audit(user, 'arm_wax_fill.gantry_home', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, before, robotId });
	return { homedAt: at.toISOString(), cycle: cycle.index, before };
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
	await patchCycle(loopId, cycle.index, { step: 'fill', sweepRunId: sweepRunId || null, barcode });
	await audit(user, 'arm_wax_fill.cycle_scan', 'arm_wax_fill_runs', loopId, { cycle: cycle.index, sweepRunId, barcode });
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
	const cart = (await CartridgeRecord.findById(barcode).select('_id status waxFilling.runId').lean()) as any;
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
			armWaxFill: { loopId, cycleIndex: cycle.index },
			notes: [
				{
					_id: generateId(),
					body: `Robot-arm wax fill: cycle ${cycle.index} of loop ${loopId}, one cart ${stage ? 'at the taught stage location' : `at deck position ${loop.cartPosition}`}.`,
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
		await attachCart(user, loop, waxRunId, cycle.barcode, settings.testMode, loop.cartPosition);
		await WaxFillingRun.updateOne({ _id: waxRunId }, { $addToSet: { cartridgeIds: cycle.barcode } });
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
		form.set('param_stage_jump_height', String(calibration!.stageJumpHeightMm));
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
 * Stop. While the arm is moving (grab / withdraw) the play is stopped and the
 * loop ends now; while the OT-2 is filling, the fill and the withdraw still
 * run (a half-filled cart is worse than one more cycle) and the loop ends
 * after them; between steps it ends at the next step.
 */
export async function stopLoop(user: User, loopId: string): Promise<{ loop: LoopView; stoppedArm: boolean; torqueOn: boolean | null }> {
	const { cycle } = await runningLoop(loopId);
	await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { stopRequested: true } });
	let stoppedArm = false;
	let torqueOn: boolean | null = null;
	if (cycle.step === 'grab' || cycle.step === 'withdraw' || cycle.step === 'scan') {
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
