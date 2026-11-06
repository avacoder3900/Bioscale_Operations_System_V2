/**
 * Robot arm physical tests — the catalog and the judges (2026-11-06).
 *
 * Each test drives the real arm, the Pi or the cameras from the Maintenance
 * Tests page, on demand, and compares one result with a limit the code already
 * defines. None of them runs in CI. The catalog and the judges are pure so
 * the browser lists the tests and vitest checks the pass / fail rules; the
 * Pi calls live in $lib/server/robot-arm-tests.
 *
 * Every run is logged twice: a RobotArmTestRun (the Test Log) and a change
 * row labelled test.<name> (the Change Log).
 */
import type { ArmHardware } from './change-labels';

export type ArmTestStatus = 'pass' | 'fail' | 'skipped' | 'error';

export interface ArmTestDef {
	key: `test.${string}`;
	title: string;
	hardware: ArmHardware;
	/** The arm, the belt or a solenoid moves. */
	moves: boolean;
	/** What passes, in one short line. */
	expected: string;
	/** Needs a move set picked on the page. */
	needsMoveSet?: boolean;
}

export const ARM_TEST_LIMITS = {
	/** Servos the follower reports. */
	servoCount: 6,
	/** Drift allowed while torque holds (hold-without-jump, 2 s). */
	holdJumpSteps: 2,
	holdWaitMs: 2000,
	/** Short move: how far each joint goes, and how close it must land (verified_move.py ARRIVAL_TOLERANCE). */
	shortMoveSteps: 50,
	arrivalSteps: 20,
	moveTimeoutMs: 8000,
	/** Repeatability: the far pose's offset and the allowed spread back at the start pose. */
	repeatOffsetSteps: 80,
	repeatRounds: 5,
	repeatSpreadSteps: 20,
	/** Droop: drift allowed over the hold with torque on. */
	droopWaitMs: 10000,
	droopSteps: 10,
	/** Return to home: how far off home the test starts, and how close counts (home-calibration HOME_STEP_TOLERANCE). */
	homeOffsetSteps: 200,
	homeLoopMs: 90000,
	/** Depth: D415 depth to a fixed tag against the calibration (depth.py MAX_SPREAD_MM). */
	depthSpreadMm: 20,
	/** Gripper: how far it opens for the test, how close it lands (CLAW_CLOSE_TOLERANCE) and the load it may press with (SERVO_LOAD_HIGH). */
	gripperOpenSteps: 60,
	gripperArrivalSteps: 40,
	gripperLoadMax: 600,
	/** Solenoid pulse (the Teach default) and how long past it the Pi may take. */
	solenoidPulseMs: 100,
	pulseSlackMs: 200,
	/** Thermals: the Pi's own hot line is read from the Pi; servos at rest stay under this (SERVO_TEMP_WARM_C). */
	servoRestC: 48,
	piHotC: 55,
	/** Supply voltage every servo must report (app.py HEALTH_VOLTAGE_LOW / HIGH). */
	voltageMin: 11.5,
	voltageMax: 13.0,
	/** Lines: one /health round trip must answer within this. */
	lineTimeoutMs: 5000,
	/** Replay: how close servos 1-5 land on the last pose. */
	replayArrivalSteps: 20
} as const;

/** Pi routes the arm pages rely on, as they appear in the Pi's openapi.json. */
export const REQUIRED_PI_ROUTES = [
	'/health',
	'/health/preflight',
	'/health/thermal',
	'/servos',
	'/servos/hold',
	'/servos/{servo_id}/move',
	'/servos/config',
	'/servos/gains',
	'/gpio/pulse',
	'/gpio/status',
	'/conveyor/pulse',
	'/conveyor/status',
	'/fires/play',
	'/depth/config',
	'/cameras/{name}/apriltags/detect',
	'/cameras/{name}/controls',
	'/recordings/restore',
	'/replay/start'
] as const;

export const ARM_TESTS: ArmTestDef[] = [
	{ key: 'test.bus_echo', title: 'Bus Echo', hardware: 'servo', moves: false, expected: '6 Servos Answer' },
	{ key: 'test.hold_no_jump', title: 'Hold Without Jump', hardware: 'servo', moves: false, expected: `Drift Under ${ARM_TEST_LIMITS.holdJumpSteps} Steps In ${ARM_TEST_LIMITS.holdWaitMs / 1000} s` },
	{ key: 'test.short_move', title: 'Short Move', hardware: 'servo', moves: true, expected: `Each Joint ${ARM_TEST_LIMITS.shortMoveSteps} Steps Out And Back Within ${ARM_TEST_LIMITS.arrivalSteps} Steps` },
	{ key: 'test.repeatability', title: 'Repeatability', hardware: 'servo', moves: true, expected: `Spread Under ${ARM_TEST_LIMITS.repeatSpreadSteps} Steps Over ${ARM_TEST_LIMITS.repeatRounds} Rounds` },
	{ key: 'test.droop', title: 'Droop', hardware: 'servo', moves: false, expected: `Drift Under ${ARM_TEST_LIMITS.droopSteps} Steps In ${ARM_TEST_LIMITS.droopWaitMs / 1000} s` },
	{ key: 'test.return_to_home', title: 'Return To Home', hardware: 'servo', moves: true, expected: `Home From ${ARM_TEST_LIMITS.homeOffsetSteps} Steps Off Within ${ARM_TEST_LIMITS.homeLoopMs / 1000} s` },
	{ key: 'test.home_check', title: 'Camera Home Check', hardware: 'vision', moves: false, expected: 'Encoders And Every Tag At Home' },
	{ key: 'test.depth_sanity', title: 'Depth Sanity', hardware: 'depth', moves: false, expected: `Fixed Tags Within ${ARM_TEST_LIMITS.depthSpreadMm} mm Of Calibration` },
	{ key: 'test.camera_preset_readback', title: 'Camera Preset Readback', hardware: 'camera', moves: false, expected: 'Controls Equal The Last Applied Preset' },
	{ key: 'test.gripper', title: 'Gripper', hardware: 'gripper', moves: true, expected: `Opens And Closes Within ${ARM_TEST_LIMITS.gripperArrivalSteps} Steps, Load Under ${ARM_TEST_LIMITS.gripperLoadMax}` },
	{ key: 'test.conveyor_pulse', title: 'Conveyor Pulse', hardware: 'conveyor', moves: true, expected: 'Default Pulse Runs And The Pin Returns Low' },
	{ key: 'test.solenoid_pulse', title: 'Solenoid Pulse', hardware: 'solenoid', moves: true, expected: `Each Pin Fires ${ARM_TEST_LIMITS.solenoidPulseMs} ms And Returns Low` },
	{ key: 'test.thermals', title: 'Thermals At Rest', hardware: 'pi', moves: false, expected: `Pi Under Its Hot Line, Servos Under ${ARM_TEST_LIMITS.servoRestC} C, No Throttle` },
	{ key: 'test.voltage', title: 'Supply Voltage', hardware: 'servo', moves: false, expected: `${ARM_TEST_LIMITS.voltageMin} To ${ARM_TEST_LIMITS.voltageMax} V On Every Servo` },
	{ key: 'test.servo_gains', title: 'Servo Gains', hardware: 'servo', moves: false, expected: 'P Gains Equal The Last Logged Values' },
	{ key: 'test.routes_present', title: 'Pi Routes Present', hardware: 'pi', moves: false, expected: `All ${REQUIRED_PI_ROUTES.length} Routes Listed` },
	{ key: 'test.lines_reachable', title: 'Lines Reachable', hardware: 'network', moves: false, expected: 'Funnel And Tunnel Answer, Wi-Fi Matches' },
	{ key: 'test.replay', title: 'Replay', hardware: 'servo', moves: true, expected: `Lands On The Last Pose Within ${ARM_TEST_LIMITS.replayArrivalSteps} Steps`, needsMoveSet: true }
];

export function armTest(key: string): ArmTestDef | null {
	return ARM_TESTS.find((t) => t.key === key) ?? null;
}

export function statusTitle(s: ArmTestStatus): string {
	return s === 'pass' ? 'Pass' : s === 'fail' ? 'Fail' : s === 'skipped' ? 'Skipped' : 'Error';
}

// ── judges (pure) ───────────────────────────────────────────────────────────

export interface Verdict {
	pass: boolean;
	/** One short line for the log. */
	message: string;
}

/** Largest |a[i] - b[i]| over the servos both read. */
export function maxDelta(a: number[], b: number[]): number {
	let m = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i] - b[i]));
	return m;
}

/** The direction a joint can move `steps` without crossing the encoder's end. */
export function awayFromLimit(position: number, steps: number, max = 4095): number {
	return position + steps > max ? -steps : position < steps ? steps : position > max / 2 ? -steps : steps;
}

export function judgeServoCount(ids: number[], expected = ARM_TEST_LIMITS.servoCount): Verdict {
	const seen = new Set(ids);
	const missing: number[] = [];
	for (let sid = 1; sid <= expected; sid++) if (!seen.has(sid)) missing.push(sid);
	return missing.length ? { pass: false, message: `Missing Servo ${missing.join(', ')}` } : { pass: true, message: `${expected} Servos Answered` };
}

export function judgeDrift(before: number[], after: number[], limit: number, what = 'Drift'): Verdict {
	const d = maxDelta(before, after);
	return { pass: d <= limit, message: `${what} ${d} Steps (Limit ${limit})` };
}

/** Per-joint spread (max - min) across samples of the same pose. */
export function spreadPerJoint(samples: number[][]): number[] {
	if (!samples.length) return [];
	const n = Math.min(...samples.map((s) => s.length));
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		const col = samples.map((s) => s[i]);
		out.push(Math.max(...col) - Math.min(...col));
	}
	return out;
}

export function judgeSpread(samples: number[][], limit: number): Verdict & { spread: number[] } {
	const spread = spreadPerJoint(samples);
	const worst = spread.length ? Math.max(...spread) : 0;
	return { pass: worst <= limit, spread, message: `Spread ${spread.join(' / ')} Steps (Limit ${limit})` };
}

export function judgeVoltage(servos: { id: number; voltage: number | null | undefined }[], min = ARM_TEST_LIMITS.voltageMin, max = ARM_TEST_LIMITS.voltageMax): Verdict {
	const bad = servos.filter((s) => typeof s.voltage !== 'number' || !Number.isFinite(s.voltage) || s.voltage < min || s.voltage > max);
	const list = servos.map((s) => (typeof s.voltage === 'number' ? s.voltage.toFixed(1) : '?')).join(' / ');
	return bad.length ? { pass: false, message: `Servo ${bad.map((s) => s.id).join(', ')} Out Of ${min}-${max} V (${list})` } : { pass: true, message: `${list} V` };
}

export function judgeThermals(
	pi: { temp_c: number | null; hot_c: number | null; now: string[] } | null,
	servos: { id: number; temperature: number | null | undefined }[],
	servoRestC = ARM_TEST_LIMITS.servoRestC
): Verdict {
	const problems: string[] = [];
	if (!pi) problems.push('Pi Thermal Not Read');
	else {
		const hot = pi.hot_c ?? ARM_TEST_LIMITS.piHotC;
		if (pi.temp_c == null) problems.push('Pi Temperature Unknown');
		else if (pi.temp_c >= hot) problems.push(`Pi ${pi.temp_c} C (Hot Line ${hot})`);
		if (pi.now.length) problems.push(`Throttle ${pi.now.join(', ')}`);
	}
	const warm = servos.filter((s) => typeof s.temperature === 'number' && s.temperature >= servoRestC);
	if (warm.length) problems.push(`Servo ${warm.map((s) => `${s.id} ${s.temperature} C`).join(', ')} (Limit ${servoRestC})`);
	const temps = servos.map((s) => (typeof s.temperature === 'number' ? s.temperature : '?')).join(' / ');
	return problems.length ? { pass: false, message: problems.join('; ') } : { pass: true, message: `Pi ${pi?.temp_c ?? '?'} C, Servos ${temps} C` };
}

export function judgeRoutes(present: string[], required: readonly string[] = REQUIRED_PI_ROUTES): Verdict & { missing: string[] } {
	const have = new Set(present);
	const missing = required.filter((r) => !have.has(r));
	return missing.length ? { pass: false, missing, message: `Missing ${missing.join(', ')}` } : { pass: true, missing, message: `${required.length} Routes Present` };
}

/** Every preset value the camera reports back unchanged. */
export function judgePresetReadback(preset: Record<string, number>, controls: { id: string; value: number | null }[]): Verdict & { differs: string[] } {
	const byId = new Map(controls.map((c) => [c.id, c.value]));
	const differs: string[] = [];
	for (const [id, v] of Object.entries(preset)) {
		const now = byId.get(id);
		if (now == null || now !== v) differs.push(`${id} ${now ?? '?'} (Preset ${v})`);
	}
	return differs.length ? { pass: false, differs, message: differs.join(', ') } : { pass: true, differs, message: `${Object.keys(preset).length} Controls Match` };
}

/** Logged P gains per servo against what the Pi reports. Only logged servos are judged. */
export function judgeGains(expected: Record<number, number>, actual: Record<number, number>): Verdict & { judged: number } {
	const ids = Object.keys(expected).map(Number);
	const wrong = ids.filter((sid) => actual[sid] !== expected[sid]).map((sid) => `Servo ${sid} P ${actual[sid] ?? '?'} (Logged ${expected[sid]})`);
	const list = Object.keys(actual)
		.map(Number)
		.sort((a, b) => a - b)
		.map((sid) => actual[sid])
		.join(' / ');
	if (!ids.length) return { pass: false, judged: 0, message: `P ${list}; No Logged Gain To Compare` };
	return wrong.length ? { pass: false, judged: ids.length, message: wrong.join(', ') } : { pass: true, judged: ids.length, message: `P ${list}` };
}

export function judgeDepth(pairs: { name: string; calibrationMm: number; nowMm: number | null }[], limit = ARM_TEST_LIMITS.depthSpreadMm): Verdict {
	if (!pairs.length) return { pass: false, message: 'No Fixed Tag With Depth' };
	const bad = pairs.filter((p) => p.nowMm == null || Math.abs(p.nowMm - p.calibrationMm) > limit);
	const list = pairs.map((p) => `${p.name} ${p.nowMm == null ? '?' : Math.round(p.nowMm - p.calibrationMm)}`).join(', ');
	return bad.length ? { pass: false, message: `Off ${list} mm (Limit ${limit})` } : { pass: true, message: `${list} mm` };
}

// ── automated unit tests (2026-11-06) ───────────────────────────────────────

/**
 * A unit test file as a short title: "src/lib/robot-arm/move-log.test.ts" →
 * "Move Log", "src/routes/api/robot-arm/cameras/[name]/controls/server.test.ts"
 * → "Cameras Controls". The path after robot-arm, without "server" leaves.
 */
export function unitFileTitle(file: string): string {
	const rest = file.replace(/\\/g, '/').replace(/^.*robot-arm[-/]/, '').replace(/\.test\.ts$/, '');
	const words = rest
		.split(/[/._-]+/)
		.filter((w) => w && w !== 'server' && !/^\[.*\]$/.test(w));
	return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || file;
}
