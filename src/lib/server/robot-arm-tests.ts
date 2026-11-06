/**
 * Robot arm physical tests — the runs (2026-11-06).
 *
 * runArmTest() drives one catalog test ($lib/robot-arm/arm-tests) against the
 * real arm from the Maintenance Tests page, judges it with the pure judges,
 * and logs it twice: a RobotArmTestRun row (the page's Test Log) and a change
 * row keyed test.<name> (the Change Log). Nothing here runs in CI.
 *
 * Rules the tests keep:
 *   - a test that moves the arm refuses while a session holds the bus or a
 *     servo is at its stop temperature (requireIdle / requireCool);
 *   - the camera is never written (camera_preset_readback only reads);
 *   - a Pi route that is not installed makes the test "skipped", not "error".
 */
import { env } from '$env/dynamic/private';
import { connectDB } from './db/connection';
import { ArmWaxFillSettings, RobotArmCameraPreset, RobotArmEndpoint, RobotArmPose, RobotArmTagCalibration, RobotArmTestRun } from './db/models';
import { robotArm, robotArmFetch, type ServoState } from './robot-arm-client';
import { afterPlay, getMoveSet, playMoveSet, playbackActive, readArm, requireCool, requireIdle, type ArmNow } from './robot-arm-animation';
import { checkHome, returnToHome } from './robot-arm-vision';
import { lastLoggedValue, logArmChange } from './robot-arm-change-log';
import {
	ARM_TEST_LIMITS as L,
	REQUIRED_PI_ROUTES,
	armTest,
	awayFromLimit,
	judgeDepth,
	judgeDrift,
	judgeGains,
	judgePresetReadback,
	judgeRoutes,
	judgeServoCount,
	judgeSpread,
	judgeThermals,
	judgeVoltage,
	maxDelta,
	statusTitle,
	type ArmTestDef,
	type ArmTestStatus
} from '$lib/robot-arm/arm-tests';
import { shouldRetryHome } from '$lib/robot-arm/home-calibration';

type User = { _id: string; username: string };

export interface ArmTestResult {
	key: string;
	title: string;
	status: ArmTestStatus;
	message: string;
	expected: string;
	measured: unknown;
	durationMs: number;
	at: string;
}

export interface ArmTestRunRow {
	_id: string;
	at: string;
	key: string;
	title: string;
	hardware: string;
	status: ArmTestStatus;
	message: string;
	expected: string;
	measured: unknown;
	durationMs: number | null;
	ranBy: { username?: string } | null;
}

interface Outcome {
	status: ArmTestStatus;
	message: string;
	measured?: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const notInstalled = (err: unknown) => /robot-arm 404/.test((err as Error)?.message ?? '');
const skipped = (message: string): Outcome => ({ status: 'skipped', message });
const verdict = (v: { pass: boolean; message: string }, measured?: unknown): Outcome => ({ status: v.pass ? 'pass' : 'fail', message: v.message, measured });

// ── servo helpers ───────────────────────────────────────────────────────────

async function servos(): Promise<ServoState[]> {
	return robotArm.listServosRetry();
}

function positionsOf(list: ServoState[]): number[] {
	const out: number[] = [];
	for (let sid = 1; sid <= L.servoCount; sid++) {
		const s = list.find((x) => x?.id === sid);
		out.push(s && Number.isFinite(s.position) ? Math.round(s.position) : NaN);
	}
	return out;
}

/** Poll the servos until every goal is within `tol`, or `timeoutMs` passes. */
async function waitArrival(goals: Map<number, number>, tol: number, timeoutMs: number): Promise<{ arrived: boolean; elapsedMs: number; list: ServoState[] }> {
	const t0 = Date.now();
	let list: ServoState[] = [];
	for (;;) {
		await sleep(250);
		list = await servos();
		const off = [...goals].filter(([sid, goal]) => {
			const s = list.find((x) => x.id === sid);
			return !s || Math.abs(s.position - goal) > tol;
		});
		if (!off.length) return { arrived: true, elapsedMs: Date.now() - t0, list };
		if (Date.now() - t0 > timeoutMs) return { arrived: false, elapsedMs: Date.now() - t0, list };
	}
}

/** The arm is free, cool enough and holding torque; the current reading comes back. */
async function readyToMove(): Promise<ArmNow> {
	await requireIdle();
	const now = await readArm();
	requireCool(now);
	if (now.torqueOn === false) throw new Error('Torque Is Off. Turn It On First.');
	return now;
}

// ── the tests ───────────────────────────────────────────────────────────────

async function busEcho(): Promise<Outcome> {
	const list = await servos();
	const v = judgeServoCount(list.map((s) => s.id));
	return verdict(v, { ids: list.map((s) => s.id), positions: positionsOf(list), temps: list.map((s) => s.temperature) });
}

async function holdNoJump(): Promise<Outcome> {
	await requireIdle();
	const before = positionsOf(await servos());
	try {
		await robotArm.holdServos();
	} catch (err) {
		if (notInstalled(err)) return skipped('Pi Has No Hold Route');
		throw err;
	}
	await sleep(L.holdWaitMs);
	const after = positionsOf(await servos());
	return verdict(judgeDrift(before, after, L.holdJumpSteps, 'Jump'), { before, after });
}

async function shortMove(): Promise<Outcome> {
	const now = await readyToMove();
	const legs: { sid: number; out: number; back: number; outMs: number; backMs: number; landed: number[] }[] = [];
	const failed: string[] = [];
	// Servos 1-5: the gripper has its own test.
	for (let sid = 1; sid <= 5; sid++) {
		const start = now.positions[sid - 1];
		const delta = awayFromLimit(start, L.shortMoveSteps);
		await robotArm.moveJoint(sid, start + delta);
		const a = await waitArrival(new Map([[sid, start + delta]]), L.arrivalSteps, L.moveTimeoutMs);
		await robotArm.moveJoint(sid, start);
		const b = await waitArrival(new Map([[sid, start]]), L.arrivalSteps, L.moveTimeoutMs);
		const landed = [a.list.find((s) => s.id === sid)?.position ?? NaN, b.list.find((s) => s.id === sid)?.position ?? NaN];
		legs.push({ sid, out: start + delta, back: start, outMs: a.elapsedMs, backMs: b.elapsedMs, landed });
		if (!a.arrived) failed.push(`Servo ${sid} Out (${landed[0]} For ${start + delta})`);
		if (!b.arrived) failed.push(`Servo ${sid} Back (${landed[1]} For ${start})`);
	}
	const times = legs.map((l) => `${l.sid}: ${((l.outMs + l.backMs) / 1000).toFixed(1)} s`).join(', ');
	return failed.length ? { status: 'fail', message: `Did Not Land: ${failed.join('; ')}`, measured: legs } : { status: 'pass', message: `All Landed (${times})`, measured: legs };
}

async function repeatability(): Promise<Outcome> {
	const now = await readyToMove();
	const A = now.positions.slice();
	const moving = [2, 3, 4, 5];
	const B = A.slice();
	for (const sid of moving) B[sid - 1] = A[sid - 1] + awayFromLimit(A[sid - 1], L.repeatOffsetSteps);
	const samples: number[][] = [];
	const misses: string[] = [];
	for (let round = 1; round <= L.repeatRounds; round++) {
		for (const sid of moving) await robotArm.moveJoint(sid, B[sid - 1]);
		const toB = await waitArrival(new Map(moving.map((sid) => [sid, B[sid - 1]])), L.arrivalSteps, L.moveTimeoutMs);
		if (!toB.arrived) misses.push(`Round ${round} Out`);
		for (const sid of moving) await robotArm.moveJoint(sid, A[sid - 1]);
		const toA = await waitArrival(new Map(moving.map((sid) => [sid, A[sid - 1]])), L.arrivalSteps, L.moveTimeoutMs);
		if (!toA.arrived) misses.push(`Round ${round} Back`);
		await sleep(300);
		samples.push(positionsOf(await servos()));
	}
	const v = judgeSpread(samples, L.repeatSpreadSteps);
	const message = misses.length ? `${v.message}; Did Not Land: ${misses.join(', ')}` : v.message;
	return { status: v.pass && !misses.length ? 'pass' : 'fail', message, measured: { start: A, far: B, samples, spread: v.spread } };
}

async function droop(): Promise<Outcome> {
	await requireIdle();
	const now = await readArm();
	if (now.torqueOn === false) return skipped('Torque Is Off');
	await sleep(L.droopWaitMs);
	const after = positionsOf(await servos());
	return verdict(judgeDrift(now.positions, after, L.droopSteps), { before: now.positions, after });
}

async function returnHome(user: User): Promise<Outcome> {
	const now = await readyToMove();
	// Shoulder lift (servo 2) off home by the test's offset, away from its end.
	const sid = 2;
	const start = now.positions[sid - 1];
	const goal = start + awayFromLimit(start, L.homeOffsetSteps);
	await robotArm.moveJoint(sid, goal);
	const away = await waitArrival(new Map([[sid, goal]]), L.arrivalSteps, L.moveTimeoutMs);
	const t0 = Date.now();
	let attempt = 1;
	// One runId for the loop, so its attempts share one hold on the arm-motion lease.
	const runId = crypto.randomUUID();
	let last = await returnToHome(user, { attempt, runId });
	let clawClosed = last.clawClosed ?? null;
	for (;;) {
		const r = shouldRetryHome({ verdict: last.home.verdict, elapsedMs: Date.now() - t0, residualMax: last.home.residualMax ?? null, clawClosed, limitMs: L.homeLoopMs });
		if (!r.retry) break;
		attempt++;
		last = await returnToHome(user, { attempt, runId });
		if (last.clawClosed != null) clawClosed = last.clawClosed;
	}
	const elapsedMs = Date.now() - t0;
	const home = last.home.verdict === 'home';
	const measured = { movedOffBy: goal - start, movedOffLanded: away.arrived, attempts: attempt, elapsedMs, verdict: last.home.verdict, residualMax: last.home.residualMax ?? null, residuals: last.residuals, clawClosed };
	return { status: home ? 'pass' : 'fail', message: home ? `Home In ${attempt} Attempt${attempt === 1 ? '' : 's'}, ${(elapsedMs / 1000).toFixed(0)} s` : last.message, measured };
}

async function homeCheck(user: User): Promise<Outcome> {
	const r = await checkHome(user, { kind: 'check' });
	const markers = (r.vision?.markers ?? []).map((m) => ({ name: m.name, status: m.status, offMm: m.offMm, offDeg: m.offDeg }));
	const measured = { verdict: r.home.verdict, residualMax: r.home.residualMax ?? null, residuals: r.residuals, markers, warnings: r.warnings };
	if (r.home.verdict === 'home') {
		const off = markers.map((m) => `${m.name} ${m.offMm == null ? '?' : m.offMm.toFixed(1)}`).join(', ');
		return { status: 'pass', message: `Encoders Within ${r.home.residualMax ?? '?'} Steps; Tags ${off} mm`, measured };
	}
	return { status: 'fail', message: r.message, measured };
}

async function depthSanity(): Promise<Outcome> {
	await connectDB();
	const doc = (await RobotArmTagCalibration.findOne({ status: 'active' }).sort({ capturedAt: -1 }).select('cameraName tags').lean()) as any;
	if (!doc) return skipped('No Active Calibration');
	const fixed = (doc.tags ?? []).filter((t: any) => t.role === 'fixed' && typeof t.depthMm === 'number' && t.depthMm > 0);
	if (!fixed.length) return skipped('Calibration Has No Fixed Tag With Depth');
	const sizes: Record<string, number> = {};
	for (const t of fixed) sizes[String(t.tagId)] = t.sizeMm;
	const det = await robotArm.detectAprilTags(doc.cameraName, { tag_sizes_mm: sizes, depth: true, frames: 1, average: 5 });
	if (!det.available) return skipped(det.reason ?? 'No Detection');
	const pairs = fixed.map((t: any) => ({ name: t.name, calibrationMm: t.depthMm, nowMm: det.tags.find((d) => d.id === t.tagId)?.depth_mm ?? null }));
	return verdict(judgeDepth(pairs), { camera: doc.cameraName, pairs });
}

async function cameraPresetReadback(): Promise<Outcome> {
	await connectDB();
	const preset = (await RobotArmCameraPreset.findOne({ archivedAt: null, lastAppliedAt: { $ne: null } }).sort({ lastAppliedAt: -1 }).lean()) as any;
	if (!preset) return skipped('No Preset Has Been Applied');
	const values: Record<string, number> = preset.values instanceof Map ? Object.fromEntries(preset.values) : { ...(preset.values ?? {}) };
	let controls;
	try {
		controls = await robotArm.getCameraControls(preset.cameraName);
	} catch (err) {
		if (notInstalled(err)) return skipped('Pi Has No Camera Controls Route');
		throw err;
	}
	if (!controls.available) return skipped(controls.reason ?? 'Camera Controls Unavailable');
	const v = judgePresetReadback(values, controls.controls);
	return { status: v.pass ? 'pass' : 'fail', message: `${preset.name}: ${v.message}`, measured: { preset: preset.name, camera: preset.cameraName, values, differs: v.differs } };
}

async function gripper(): Promise<Outcome> {
	const now = await readyToMove();
	const sid = 6;
	const closed = now.positions[sid - 1];
	const open = closed + L.gripperOpenSteps;
	await robotArm.moveJoint(sid, open);
	const a = await waitArrival(new Map([[sid, open]]), L.gripperArrivalSteps, L.moveTimeoutMs);
	const openRead = a.list.find((s) => s.id === sid);
	await robotArm.moveJoint(sid, closed);
	const b = await waitArrival(new Map([[sid, closed]]), L.gripperArrivalSteps, L.moveTimeoutMs);
	const closedRead = b.list.find((s) => s.id === sid);
	const loads = [openRead?.load ?? 0, closedRead?.load ?? 0];
	const loadOk = loads.every((l) => Math.abs(l) < L.gripperLoadMax);
	const measured = { closed, open, landedOpen: openRead?.position ?? null, landedClosed: closedRead?.position ?? null, loads };
	const problems: string[] = [];
	if (!a.arrived) problems.push(`Open Landed ${openRead?.position ?? '?'} For ${open}`);
	if (!b.arrived) problems.push(`Close Landed ${closedRead?.position ?? '?'} For ${closed}`);
	if (!loadOk) problems.push(`Load ${loads.join(' / ')} (Limit ${L.gripperLoadMax})`);
	return problems.length ? { status: 'fail', message: problems.join('; '), measured } : { status: 'pass', message: `Open ${openRead?.position}, Closed ${closedRead?.position}, Load ${loads.join(' / ')}`, measured };
}

async function conveyorPulse(): Promise<Outcome> {
	await connectDB();
	const settings = (await ArmWaxFillSettings.findById('default').select('conveyorPulseMs').lean()) as { conveyorPulseMs?: number } | null;
	const ms = settings?.conveyorPulseMs ?? 600;
	let st;
	try {
		st = await robotArm.conveyorPulse({ ms, delay_ms: 0 });
	} catch (err) {
		if (notInstalled(err)) return skipped('Pi Has No Conveyor Route');
		throw err;
	}
	const t0 = Date.now();
	let sawOn = st.running;
	let last = st;
	while (Date.now() - t0 < ms + 3000) {
		await sleep(200);
		last = await robotArm.conveyorStatus();
		if (last.running) sawOn = true;
		else break;
	}
	const elapsedMs = Date.now() - t0;
	const measured = { pin: last.pin, ms, elapsedMs, sawOn, finalState: last.state, simulated: last.simulated };
	if (last.running) return { status: 'fail', message: `Still Running After ${elapsedMs} ms`, measured };
	if (last.state !== 0) return { status: 'fail', message: `Pin ${last.pin} Stayed High`, measured };
	return { status: 'pass', message: `${ms} ms On Pin ${last.pin}, Low Again After ${elapsedMs} ms${last.simulated ? ' (Simulated)' : ''}`, measured };
}

async function solenoidPulse(): Promise<Outcome> {
	let gs;
	try {
		gs = await robotArm.gpioStatus();
	} catch (err) {
		if (notInstalled(err)) return skipped('Pi Has No GPIO Route');
		throw err;
	}
	const pins = (gs.allowed_pins ?? Object.keys(gs.pins).map(Number)).filter((p) => Number.isInteger(p));
	if (!pins.length) return skipped('No Solenoid Pins');
	const fired: { pin: number; elapsed_ms: number }[] = [];
	for (const pin of pins) {
		const r = await robotArm.pulseGpio({ pin, ms: L.solenoidPulseMs });
		fired.push({ pin, elapsed_ms: r.elapsed_ms });
		await sleep(300);
	}
	const after = await robotArm.gpioStatus();
	const high = pins.filter((p) => after.pins[String(p)]?.state === 1);
	const slow = fired.filter((f) => f.elapsed_ms < L.solenoidPulseMs || f.elapsed_ms > L.solenoidPulseMs + L.pulseSlackMs);
	const measured = { pins, fired, simulated: gs.simulated };
	const problems: string[] = [];
	if (high.length) problems.push(`Pin ${high.join(', ')} Stayed High`);
	if (slow.length) problems.push(`Pin ${slow.map((f) => `${f.pin} ${f.elapsed_ms} ms`).join(', ')} Off ${L.solenoidPulseMs} ms`);
	return problems.length ? { status: 'fail', message: problems.join('; '), measured } : { status: 'pass', message: `Pins ${pins.join(', ')} Fired ${L.solenoidPulseMs} ms${gs.simulated ? ' (Simulated)' : ''}`, measured };
}

async function thermals(): Promise<Outcome> {
	let pi: { temp_c: number | null; hot_c: number | null; now: string[] } | null = null;
	try {
		const t = await robotArm.getThermal();
		pi = { temp_c: t.temp_c, hot_c: t.thresholds?.hot_c ?? null, now: t.now ?? [] };
	} catch (err) {
		if (!notInstalled(err)) throw err;
	}
	const list = await servos();
	return verdict(judgeThermals(pi, list), { pi, servos: list.map((s) => ({ id: s.id, temperature: s.temperature })) });
}

async function voltage(): Promise<Outcome> {
	const list = await servos();
	return verdict(judgeVoltage(list), list.map((s) => ({ id: s.id, voltage: s.voltage })));
}

async function servoGains(): Promise<Outcome> {
	let cfg: { servos?: { id: number; P_Coefficient?: number }[] };
	try {
		cfg = await robotArmFetch('/servos/config', { timeoutMs: 6000 });
	} catch (err) {
		if (notInstalled(err)) return skipped('Pi Has No Servo Config Route');
		throw err;
	}
	const actual: Record<number, number> = {};
	for (const s of cfg.servos ?? []) if (typeof s.P_Coefficient === 'number') actual[s.id] = s.P_Coefficient;
	const expected: Record<number, number> = {};
	for (const sid of Object.keys(actual).map(Number)) {
		const logged = await lastLoggedValue('servo.p_coefficient', `servo:${sid}`);
		if (logged && typeof logged.newValue === 'number') expected[sid] = logged.newValue;
	}
	const v = judgeGains(expected, actual);
	if (!v.judged) return { status: 'skipped', message: v.message, measured: { actual } };
	return verdict(v, { actual, expected });
}

async function routesPresent(): Promise<Outcome> {
	const spec = await robotArmFetch<{ paths?: Record<string, unknown> }>('/openapi.json', { timeoutMs: 6000 });
	const present = Object.keys(spec.paths ?? {});
	let version: string | null = null;
	try {
		version = (await robotArm.health()).version ?? null;
	} catch {
		/* the route list is the test */
	}
	const v = judgeRoutes(present);
	return verdict(v, { version, routes: present.length, missing: v.missing });
}

async function probeLine(base: string): Promise<{ ok: boolean; ms: number; detail: string }> {
	const t0 = Date.now();
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), L.lineTimeoutMs);
		const res = await fetch(`${base.replace(/\/$/, '')}/health`, { headers: { 'x-api-key': env.ROBOT_ARM_API_KEY ?? '' }, signal: controller.signal }).finally(() => clearTimeout(timer));
		return { ok: res.ok, ms: Date.now() - t0, detail: `HTTP ${res.status}` };
	} catch (err) {
		return { ok: false, ms: Date.now() - t0, detail: (err as Error)?.name === 'AbortError' ? 'Timed Out' : ((err as Error)?.message ?? 'Failed') };
	}
}

async function linesReachable(): Promise<Outcome> {
	const funnelUrl = env.ROBOT_ARM_BASE_URL ?? null;
	await connectDB();
	const row = (await RobotArmEndpoint.findById('tunnel').lean()) as { url?: string; registeredAt?: Date } | null;
	const tunnelAge = row?.registeredAt ? Date.now() - new Date(row.registeredAt).getTime() : Infinity;
	const tunnelUrl = row?.url && tunnelAge < 48 * 3600 * 1000 ? row.url : null;
	const [funnel, tunnel] = await Promise.all([funnelUrl ? probeLine(funnelUrl) : null, tunnelUrl ? probeLine(tunnelUrl) : null]);
	let wifi: { ssid: string | null; expected: string | null } | null = null;
	try {
		const t = await robotArm.getThermal();
		if (t.network) wifi = { ssid: t.network.ssid, expected: t.network.expected_ssid };
	} catch {
		/* no thermal route: no Wi-Fi reading */
	}
	const problems: string[] = [];
	if (!funnel) problems.push('No Funnel URL Set');
	else if (!funnel.ok) problems.push(`Funnel ${funnel.detail}`);
	if (tunnel && !tunnel.ok) problems.push(`Tunnel ${tunnel.detail}`);
	if (wifi?.expected && wifi.ssid !== wifi.expected) problems.push(`Wi-Fi ${wifi.ssid ?? 'None'} (Expected ${wifi.expected})`);
	const measured = { funnel: funnel ? { url: funnelUrl, ...funnel } : null, tunnel: tunnel ? { url: tunnelUrl, ...tunnel } : null, wifi };
	const okLine = [funnel ? `Funnel ${funnel.ms} ms` : null, tunnel ? `Tunnel ${tunnel.ms} ms` : 'No Tunnel Registered', wifi?.ssid ? `Wi-Fi ${wifi.ssid}` : null].filter(Boolean).join(', ');
	return problems.length ? { status: 'fail', message: problems.join('; '), measured } : { status: 'pass', message: okLine, measured };
}

async function replay(user: User, moveSetId: string | null): Promise<Outcome> {
	if (!moveSetId) return skipped('Pick A Move Set');
	const ms = await getMoveSet(moveSetId);
	if (!ms) return skipped('Move Set Not Found');
	const lastPose = [...ms.keyframes].reverse().find((k: any) => k?.poseId);
	if (!lastPose) return skipped('Move Set Has No Pose');
	await connectDB();
	const pose = (await RobotArmPose.findById((lastPose as any).poseId).select('positions name').lean()) as { positions?: number[]; name?: string } | null;
	if (!pose?.positions) return skipped('Last Pose Not Found');
	const goals = pose.positions.map((p, i) => p + ((lastPose as any).offsets?.[i] ?? 0));
	await readyToMove();
	const play = await playMoveSet(user, moveSetId);
	const t0 = Date.now();
	const budget = Math.min(100_000, play.durationS * 1000 + 15_000);
	let active = await playbackActive(play.runId);
	while (active && Date.now() - t0 < budget) {
		await sleep(1000);
		active = await playbackActive(play.runId);
	}
	if (active) return { status: 'fail', message: `Still Playing After ${Math.round(budget / 1000)} s`, measured: { runId: play.runId, durationS: play.durationS } };
	await afterPlay(user, play.runId);
	const now = await readArm();
	const deltas = goals.slice(0, 5).map((g, i) => now.positions[i] - g);
	const worst = maxDelta(goals.slice(0, 5), now.positions.slice(0, 5));
	const measured = { moveSet: ms.name, lastPose: pose.name, runId: play.runId, durationS: play.durationS, playedS: (Date.now() - t0) / 1000, goals, landed: now.positions, deltas, warnings: play.warnings };
	return { status: worst <= L.replayArrivalSteps ? 'pass' : 'fail', message: `${ms.name}: Off ${deltas.join(' / ')} Steps After ${measured.playedS.toFixed(0)} s (Limit ${L.replayArrivalSteps})`, measured };
}

// ── runner ──────────────────────────────────────────────────────────────────

async function runOne(def: ArmTestDef, user: User, opts: { moveSetId?: string | null }): Promise<Outcome> {
	switch (def.key) {
		case 'test.bus_echo':
			return busEcho();
		case 'test.hold_no_jump':
			return holdNoJump();
		case 'test.short_move':
			return shortMove();
		case 'test.repeatability':
			return repeatability();
		case 'test.droop':
			return droop();
		case 'test.return_to_home':
			return returnHome(user);
		case 'test.home_check':
			return homeCheck(user);
		case 'test.depth_sanity':
			return depthSanity();
		case 'test.camera_preset_readback':
			return cameraPresetReadback();
		case 'test.gripper':
			return gripper();
		case 'test.conveyor_pulse':
			return conveyorPulse();
		case 'test.solenoid_pulse':
			return solenoidPulse();
		case 'test.thermals':
			return thermals();
		case 'test.voltage':
			return voltage();
		case 'test.servo_gains':
			return servoGains();
		case 'test.routes_present':
			return routesPresent();
		case 'test.lines_reachable':
			return linesReachable();
		case 'test.replay':
			return replay(user, opts.moveSetId ?? null);
		default:
			return { status: 'error', message: 'Not Implemented' };
	}
}

/** Run one catalog test, log it, and answer with the result. Throws only for an unknown key. */
export async function runArmTest(user: User, key: string, opts: { moveSetId?: string | null } = {}): Promise<ArmTestResult> {
	const def = armTest(key);
	if (!def) throw new Error(`Unknown test ${key}`);
	const t0 = Date.now();
	let out: Outcome;
	try {
		out = await runOne(def, user, opts);
	} catch (err) {
		out = { status: 'error', message: (err as Error)?.message ?? String(err) };
	}
	const durationMs = Date.now() - t0;
	const at = new Date();
	const measured = out.measured === undefined ? null : JSON.parse(JSON.stringify(out.measured));
	try {
		await connectDB();
		await RobotArmTestRun.create({ at, key: def.key, title: def.title, hardware: def.hardware, status: out.status, message: out.message.slice(0, 1000), expected: def.expected, measured, durationMs, ranBy: { _id: user._id, username: user.username } });
	} catch (err) {
		console.warn('[arm-tests] run not logged:', err instanceof Error ? err.message : err);
	}
	await logArmChange(user, { page: 'maintenance.tests', hardware: def.hardware, key: def.key, newValue: statusTitle(out.status), source: 'test', note: out.message.slice(0, 300), details: measured, at });
	return { key: def.key, title: def.title, status: out.status, message: out.message, expected: def.expected, measured, durationMs, at: at.toISOString() };
}

/** Newest first. */
export async function listArmTestRuns(o: { limit?: number } = {}): Promise<ArmTestRunRow[]> {
	await connectDB();
	const rows = await RobotArmTestRun.find({})
		.sort({ at: -1 })
		.limit(Math.min(Math.max(o.limit ?? 200, 1), 1000))
		.select('at key title hardware status message expected measured durationMs ranBy')
		.lean();
	return JSON.parse(JSON.stringify(rows));
}

/** The newest run per test, keyed by test key. */
export async function latestArmTestRuns(): Promise<Record<string, ArmTestRunRow>> {
	await connectDB();
	const rows = (await RobotArmTestRun.aggregate([{ $sort: { at: -1 } }, { $group: { _id: '$key', doc: { $first: '$$ROOT' } } }])) as { _id: string; doc: unknown }[];
	const out: Record<string, ArmTestRunRow> = {};
	for (const r of rows) out[r._id] = JSON.parse(JSON.stringify(r.doc));
	return out;
}
