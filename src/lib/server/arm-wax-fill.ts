/**
 * Robot-arm wax fill line (/manufacturing/cart-mfg/robot-arm/wax-fill).
 *
 * One cart at a time: the arm plays its GRAB animation (an Animate move set or
 * sequence) to put a cart on the OT-2, the gantry scanner reads the cart at
 * the taught scan position (a one-slot scanner sweep), the OT-2 runs the
 * ordinary wax-filling protocol with `cartridges = 1` at the configured deck
 * position, and the arm plays its WITHDRAW animation. The browser drives each
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
 * the cart location is sent to the protocol as arm_cart_x/y/z when its
 * parameter schema declares them.
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
	WaxFillingRun
} from '$lib/server/db';
import { checkRobotConflict } from '$lib/server/manufacturing/resource-locks';
import { consumeCarts, findBucketLabels, BucketError } from '$lib/server/services/bucket-service';
import { currentProtocolEntry } from '$lib/server/opentrons/protocol-freshness';
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
	const cartPosition = Math.round(num(input.cartPosition, 'Cart position'));
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
}

export interface CalibrationView {
	robotId: string;
	scanPosition: TaughtPoint | null;
	scanPositionSetId: string | null;
	cartLocation: TaughtPoint | null;
	pipetteMount: 'left' | 'right';
	pipetteName: string | null;
}

function point(d: any): TaughtPoint | null {
	if (!d || typeof d.x !== 'number' || typeof d.y !== 'number' || typeof d.z !== 'number') return null;
	return {
		x: d.x,
		y: d.y,
		z: d.z,
		taughtAt: d.taughtAt ? new Date(d.taughtAt).toISOString() : null,
		taughtBy: d.taughtBy?.username ?? null,
		testScanBarcode: d.testScanBarcode ?? null
	};
}

function calibrationView(robotId: string, d: any): CalibrationView {
	return {
		robotId,
		scanPosition: point(d?.scanPosition),
		scanPositionSetId: d?.scanPositionSetId ?? null,
		cartLocation: point(d?.cartLocation),
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

export async function saveCartLocation(user: User, robotId: string, input: PointInput): Promise<CalibrationView> {
	await connectDB();
	if (!robotId) throw new ArmWaxFillError('Save the setup (robot) first.');
	const p = cleanPoint(input);
	const prev = (await ArmWaxFillCalibration.findById(robotId).lean()) as any;
	const mount = mountOf(input, prev?.pipetteMount ?? 'left');
	const pipetteName = String(input.pipetteName ?? '').trim() || prev?.pipetteName || null;
	const now = new Date();
	await ArmWaxFillCalibration.updateOne(
		{ _id: robotId },
		{ $set: { cartLocation: { ...p, taughtAt: now, taughtBy: opRef(user) }, pipetteMount: mount, pipetteName, updatedBy: opRef(user) } },
		{ upsert: true }
	);
	await audit(user, 'arm_wax_fill.cart_location', 'arm_wax_fill_calibrations', robotId, { ...p, before: point(prev?.cartLocation) });
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
	if (!settings.robotId) blocking.push('Setup: pick the OT-2 the arm feeds.');
	if (!settings.grabAnimation) blocking.push('Animations: choose the grab animation.');
	if (!settings.withdrawAnimation) blocking.push('Animations: choose the withdraw animation.');
	if (settings.robotId && !protocol) blocking.push('The robot has no wax-filling protocol uploaded — upload it on /opentrons first.');
	if (settings.robotId && !calibration?.scanPosition) blocking.push('Calibration: teach the scan position.');
	if (settings.robotId && !calibration?.cartLocation) {
		if (protocol?.declaresCartLocation) blocking.push('Calibration: teach the cart location (the protocol reads arm_cart_x/y/z).');
		else notes.push(`Cart location is not taught. The current protocol does not read it; it fills deck position ${settings.cartPosition} from the deck calibration.`);
	} else if (calibration?.cartLocation && protocol && !protocol.declaresCartLocation) {
		notes.push(`The current protocol does not declare arm_cart_x/y/z, so the taught cart location is kept but not sent; it fills deck position ${settings.cartPosition}.`);
	}
	if (active) blocking.push(`A loop is already running (started ${active.startedAt ? new Date(active.startedAt).toLocaleString() : ''}).`);
	if (robotConflict) blocking.push(`${robotConflict} (Robots page)`);
	return { blocking, notes };
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
	const robotName = (robots as any[]).find((r) => String(r._id) === settings.robotId)?.name ?? null;
	return {
		settings,
		robotName,
		scannerDeviceId: scannerDeviceIdForRobot(robotName),
		robots: (robots as any[]).map((r) => ({ _id: String(r._id), name: r.name ?? String(r._id) })),
		moveSets: moveSets.filter((m) => !m.archived).map((m) => ({ _id: m._id, name: m.name, keyframes: m.keyframes.length })),
		sequences: sequences.filter((s) => !s.archived).map((s) => ({ _id: s._id, name: s.name, items: s.items.length })),
		calibration,
		protocol,
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

/** Step 1: the arm MOVES through the grab animation. */
export async function cycleGrab(user: User, loopId: string): Promise<{ play: PlayResult; cycle: number }> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'grab');
	if (loop.stopRequested) throw new ArmWaxFillError('Stop was requested — the loop ends here.', 409);
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
 * wax-filling protocol with cartridges = 1 at the configured position. The
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
					body: `Robot-arm wax fill: cycle ${cycle.index} of loop ${loopId}, one cart at deck position ${loop.cartPosition}.`,
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
	form.set('param_cartridges', '1');
	form.set('param_resume_cartridge', String(loop.cartPosition));
	form.set('param_resume_hole', '1');
	if (protocol.declaresCartLocation && calibration?.cartLocation) {
		form.set('param_arm_cart_x', String(calibration.cartLocation.x));
		form.set('param_arm_cart_y', String(calibration.cartLocation.y));
		form.set('param_arm_cart_z', String(calibration.cartLocation.z));
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

/** Step 4: the arm MOVES through the withdraw animation. */
export async function cycleWithdraw(user: User, loopId: string): Promise<{ play: PlayResult; cycle: number }> {
	const { loop, cycle } = await runningLoop(loopId);
	expectStep(cycle, 'withdraw');
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
