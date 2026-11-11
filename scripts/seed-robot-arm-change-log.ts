/**
 * Backfill the robot arm Change Log with the changes made before the log
 * existed (2026-05 to 2026-11-06), from git history and progress.txt.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/seed-robot-arm-change-log.ts            # report
 *   npx tsx --tsconfig tsconfig.json scripts/seed-robot-arm-change-log.ts --apply    # write
 *
 * Idempotent: every row has a fixed id (armchg-hist-NNN); rows already present
 * are left alone. Labels per src/lib/robot-arm/change-labels.ts.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { RobotArmChange } from '../src/lib/server/db/models/index.js';
import { changeLine, type ArmHardware, type ArmPage, type ArmSource } from '../src/lib/robot-arm/change-labels.js';

const APPLY = process.argv.includes('--apply');

type Row = [date: string, page: ArmPage, hardware: ArmHardware, key: string, target: string | null, oldValue: unknown, newValue: unknown, unit: string | null, source: ArmSource, note: string | null];

// APPEND ONLY: ids are armchg-hist-<position>; a row inserted mid-list re-ids every row after it.
const ROWS: Row[] = [
	// Servos and motion
	['2026-11-05', 'teach', 'servo', 'servo.p_coefficient', 'servo:2', 6, 16, null, 'pi', 'POST /servos/gains, saved to EEPROM'],
	['2026-11-05', 'teach', 'servo', 'servo.p_coefficient', 'servo:3', 6, 16, null, 'pi', 'POST /servos/gains, saved to EEPROM'],
	['2026-11-06', 'teach', 'servo', 'servo.p_coefficient', 'servo:4', 10, 16, null, 'pi', 'POST /servos/gains, saved to EEPROM'],
	['2026-11-06', 'teach', 'servo', 'servo.p_coefficient', 'servo:5', 15, 16, null, 'pi', 'POST /servos/gains, saved to EEPROM'],
	['2026-11-06', 'teach', 'servo', 'servo.p_coefficient', 'servo:6', 10, 16, null, 'pi', 'POST /servos/gains, saved to EEPROM'],
	['2026-11-05', 'teach', 'servo', 'motion.max_steps_per_s', null, 2000, 7000, 'steps/s', 'code', 'A warning, not a block'],
	['2026-11-05', 'teach', 'servo', 'motion.droop_cap_steps', null, 50, 300, 'steps', 'code', null],
	['2026-11-05', 'pi', 'servo', 'replay.ramp_s', null, 3, 'by distance', 's', 'code', 'Replay ramps to its start pose only as long as the distance needs'],
	['2026-10-15', 'maintenance.control', 'leader-arm', 'teleop.rate_hz', null, 10, 30, 'Hz', 'code', 'Matches the Pi service'],
	['2026-10-21', 'calibrate.arm', 'servo', 'home.loop_ms', null, null, 90000, 'ms', 'code', 'Return To Home repeats until home'],
	['2026-10-21', 'calibrate.arm', 'servo', 'home.jog_chunk_steps', null, null, 300, 'steps', 'code', "The Pi's cap per jog"],
	['2026-10-23', 'calibrate.arm', 'gripper', 'home.claw_close_after_ms', null, null, 5000, 'ms', 'code', null],
	['2026-10-23', 'calibrate.arm', 'gripper', 'home.claw_close_tolerance_steps', null, null, 40, 'steps', 'code', null],
	['2026-10-23', 'calibrate.arm', 'vision', 'vision.tolerance_mm', null, null, 10, 'mm', 'code', 'Shared by Calibrate home and verified poses'],
	['2026-10-23', 'pi', 'servo', 'servo.limit_steps', 'servo:1', null, '718-3317', 'steps', 'pi', 'EEPROM limits read by the move route; home 1991'],
	['2026-10-23', 'teach', 'servo', 'servo.temp_warm_c', null, null, 48, 'C', 'code', null],
	['2026-10-23', 'teach', 'servo', 'servo.temp_hot_c', null, null, 55, 'C', 'code', null],
	['2026-10-23', 'teach', 'servo', 'servo.temp_stop_c', null, null, 65, 'C', 'code', 'No motion starts at or above this'],
	// Cameras
	['2026-10-23', 'calibrate.arm', 'camera', 'camera.preset', 'camera:arm', null, 'Shared Office with Blinds Open', null, 'ui', "The camera's own defaults, saved as the first preset"],
	['2026-10-21', 'pi', 'camera', 'camera.resolution', 'camera:arm', null, '1920x1080', null, 'pi', 'Pi config'],
	['2026-10-21', 'pi', 'camera', 'camera.fps', 'camera:arm', null, 30, 'fps', 'pi', null],
	['2026-10-21', 'hand', 'camera', 'hardware.cable', 'camera:arm', null, 'USB 3', null, 'hand', null],
	['2026-10-20', 'calibrate.arm', 'camera', 'camera.rotation_deg', 'camera:arm', null, 90, 'deg', 'code', 'View rotates left or right'],
	['2026-10-23', 'calibrate.arm', 'depth', 'depth.mode', null, '480p', '720p', null, 'ui', null],
	['2026-10-19', 'calibrate.arm', 'depth', 'depth.zero_baseline', null, null, 'Set', null, 'ui', 'RealSense depth zero baseline'],
	['2026-10-19', 'calibrate.arm', 'vision', 'vision.method', null, 'home camera', 'stickers', null, 'code', 'ARM-04'],
	['2026-10-20', 'calibrate.arm', 'vision', 'vision.method', null, 'stickers', 'apriltag', null, 'code', 'ARM-05'],
	['2026-10-20', 'calibrate.arm', 'vision', 'vision.upscale', null, null, 2, 'x', 'code', null],
	['2026-10-28', 'calibrate.arm', 'vision', 'vision.detections', null, null, 5, null, 'code', "Alejandro's pick"],
	['2026-10-28', 'calibrate.arm', 'vision', 'vision.stack_frames', null, null, 5, null, 'code', null],
	// GPIO
	['2026-10-28', 'teach', 'solenoid', 'solenoid.pulse_ms', null, 1000, 100, 'ms', 'code', null],
	['2026-11-04', 'teach', 'conveyor', 'conveyor.gpio', null, null, 22, null, 'code', 'Pin 15'],
	['2026-11-04', 'teach', 'conveyor', 'conveyor.pulse_ms', null, null, 600, 'ms', 'code', 'Default until one is saved'],
	['2026-11-05', 'teach', 'conveyor', 'fire.wait_s_min', null, null, 0, 's', 'code', 'Fire steps may wait 0 s after the pulse'],
	// Stage
	['2026-10-28', 'calibrate.stage', 'stage', 'stage.rotation_deg', null, null, 90, 'deg', 'code', 'A quarter turn from a carriage slot'],
	['2026-10-28', 'calibrate.stage', 'stage', 'stage.cart_shift_cap_mm', null, 10, 'none', 'mm', 'code', 'Shift Whole Cart is a re-teach'],
	// Pi software
	['2026-10-15', 'pi', 'solenoid', 'pi.router.gpio', null, null, 'Installed', null, 'pi', null],
	['2026-10-16', 'pi', 'pi', 'pi.router.recordings', null, null, 'Installed', null, 'pi', null],
	['2026-10-16', 'pi', 'pi', 'recordings.trash_days', null, null, 30, 'days', 'code', null],
	['2026-10-20', 'pi', 'vision', 'pi.router.apriltag', null, null, 'Installed', null, 'pi', null],
	['2026-10-21', 'pi', 'pi', 'pi.router.thermal', null, null, 'Installed', null, 'pi', null],
	['2026-10-21', 'pi', 'pi', 'pi.jpeg_encoding', null, 'eager', 'lazy', null, 'pi', 'Pi heat'],
	['2026-10-22', 'pi', 'servo', 'pi.router.move', null, null, 'Installed', null, 'pi', null],
	['2026-10-22', 'pi', 'servo', 'pi.router.bus_lock', null, null, 'Installed', null, 'pi', null],
	['2026-10-22', 'pi', 'servo', 'pi.router.replay_settle', null, null, 'Installed', null, 'pi', null],
	['2026-10-23', 'pi', 'servo', 'pi.router.hold', null, null, 'Installed', null, 'pi', null],
	['2026-10-23', 'pi', 'depth', 'pi.router.depth', null, null, 'Installed', null, 'pi', null],
	['2026-10-23', 'pi', 'camera', 'pi.router.vision_quality', null, null, 'Installed', null, 'pi', null],
	['2026-10-23', 'pi', 'servo', 'pi.router.servos', null, null, 'Installed', null, 'pi', null],
	['2026-11-04', 'pi', 'conveyor', 'pi.router.conveyor', null, null, 'Installed', null, 'pi', null],
	['2026-11-04', 'pi', 'solenoid', 'pi.router.fires', null, null, 'Installed', null, 'pi', null],
	['2026-11-05', 'pi', 'servo', 'pi.router.servo_config', null, null, 'Installed', null, 'pi', null],
	// Network
	['2026-07-30', 'pi', 'network', 'network.base_url', null, null, 'Set', null, 'pi', 'ROBOT_ARM_BASE_URL corrected'],
	['2026-10-19', 'pi', 'network', 'network.funnel_watchdog', null, null, 'Installed', null, 'pi', 'Tailscale Funnel back on by itself'],
	['2026-10-19', 'pi', 'network', 'network.tunnel', null, null, 'Registered', null, 'pi', 'Cloudflare quick tunnel, second route'],
	['2026-10-22', 'pi', 'network', 'pi.wifi_ssid', null, null, 'Aquinas_Townpark', null, 'pi', 'Preferred network'],
	// Hand
	['2026-05-15', 'hand', 'servo', 'hardware.com_port', 'follower', null, 'Diagnosed', null, 'hand', null],
	['2026-08-19', 'hand', 'leader-arm', 'hardware.com_port', 'leader', null, 'Re-registered', null, 'hand', 'BusLinker'],
	['2026-10-15', 'hand', 'solenoid', 'hardware.wiring', null, null, 'Solenoid driver on the bench', null, 'hand', null],
	// Append only below this line: a row's id is its position, so inserting above would shift every later id.
	['2026-11-06', 'teach', 'servo', 'motion.max_steps_per_s', null, 7000, 'none', 'steps/s', 'code', 'No speed limit on a step (fc128ae1)'],
	// Code changes after the first backfill (2026-11-06; times are the commits', UTC). A date with a time is used as is.
	['2026-11-05T22:31:00Z', 'teach', 'servo', 'motion.droop_correction', null, false, true, null, 'code', 'Every pose is droop-corrected (530a24d5)'],
	['2026-11-06T16:16:00Z', 'teach', 'servo', 'motion.droop_settle_target', null, 'trimmed goal', 'pose', null, 'code', 'Pi settle aims at the pose; Clear All Droop added (d604c46a)'],
	['2026-11-06T16:45:00Z', 'teach', 'servo', 'motion.movers', null, 'any', 'one at a time', null, 'code', 'Return Home, droop settle and Play share one lease (e3d5b45b)'],
	['2026-11-06T17:14:00Z', 'teach', 'servo', 'motion.droop_correction', null, true, false, null, 'code', 'Plays send the Live-posing numbers exactly; stored trims purged (2df2d785)'],
	['2026-11-06T18:45:00Z', 'maintenance.tests', 'servo', 'tests.replay', null, 'In Tests', 'Removed', null, 'code', 'No Replay test on Maintenance -> Tests (7f494b73)'],
	['2026-11-06T19:20:00Z', 'run', 'network', 'link.ot2_path', null, 'BIMS queue', 'USB-B cable', null, 'code', 'Arm Pi <-> OT-2 over the cable; the loop handshake goes through it (19243518)'],
	['2026-11-06T19:29:00Z', 'teach', 'servo', 'teach.goto_show_steps', 'pose-editor', 80, 20, 'steps', 'code', 'Go To Pose shows once a servo is over 20 steps off (adb3b54f)'],
	['2026-11-06T19:38:00Z', 'teach', 'servo', 'teach.goto_show_steps', 'camera-card', 80, 20, 'steps', 'code', 'Camera card Go To Pose, same rule (8e9ed69f)'],
	['2026-11-06T20:32:00Z', 'run', 'gripper', 'loop.first_grab_waits_for', null, null, 'ARM CALIBRATED', null, 'code', 'No tip on the OT-2, no arm motion (c4da8059)'],
	['2026-11-06T20:39:00Z', 'calibrate.arm', 'servo', 'home.jog_speed', null, 'full', 600, 'steps/s', 'code', 'Return To Home jogs at a capped speed, full speed put back after (4accb024)'],
	['2026-11-06T20:47:00Z', 'run', 'stage', 'setup.scan_presence_only', null, null, 'Added', null, 'code', 'Setup box Barcode Present Only (26ea0d2b)'],
	['2026-11-06T21:07:00Z', 'run', 'network', 'link.home_timeout_s', null, 80, 60, 's', 'code', "Home Gantry through the cable link: the Pi's limit is 60 s (a073ed2d)"],
	['2026-11-10T22:26:14Z', 'maintenance.moves', 'servo', 'log.arrival', null, null, 'Added', null, 'code', 'Arrival row after every play, Pose Saved rows, load in readings (02b4cb5c)'],
	['2026-11-10T22:39:56Z', 'pi', 'servo', 'pi.router.servo_state', null, null, 'Installed', null, 'pi', 'GET /servos/state: goal register, current, status bits, gains (servo_config.py; backup .bak-pre-state-20261110)'],
	['2026-11-11T15:23:49Z', 'pi', 'servo', 'pi.router.servo_trace', null, null, 'Installed', null, 'pi', 'GET /servos/trace: every servo sampled at up to 100 Hz after a play, yields to a waiting play (servo_config.py; backup .bak-pre-trace-20261111)'],
	['2026-11-11T15:30:00Z', 'maintenance.moves', 'servo', 'log.arrival_trace', null, null, 'Added', null, 'code', 'Arrival rows keep a 3 s, 50 Hz trace with swing, turns and shake speed per servo; Show Trace'],
	['2026-11-11T16:56:00Z', 'pi', 'servo', 'pi.torque_on_goal_sync', null, 'enable only', 'goal 0 or > 200 off set to position first', 'steps', 'pi', 'After a power loss every goal read 0; torque-on would drive the arm toward 0 (manual_control.py; backup .bak-pre-torque-sync-20261111)'],
	['2026-11-11T21:20:00Z', 'pi', 'servo', 'pi.replay_inplay_samples', null, null, 'Added', null, 'pi', 'Every play reads the six positions after each frame (when time allows) and keeps them per run; GET /replay/measured/{run_id} (replay_settle.py, servo_config.py; backups .bak-pre-inplay-20261111)'],
	['2026-11-11T21:25:00Z', 'maintenance.moves', 'servo', 'log.arrival_inplay', null, null, 'Added', null, 'code', 'Arrival rows keep where the arm was during the play: per servo max error from its goals and extra turns (wobble); Show In Play']
];

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) throw new Error('MONGODB_URI not set');
	await mongoose.connect(uri);
	let written = 0;
	let present = 0;
	for (let i = 0; i < ROWS.length; i++) {
		const [date, page, hardware, key, target, oldValue, newValue, unit, source, note] = ROWS[i];
		const _id = `armchg-hist-${String(i + 1).padStart(3, '0')}`;
		const line = changeLine({ page, hardware, key, target, oldValue, newValue, unit });
		if (await RobotArmChange.exists({ _id })) {
			present++;
			continue;
		}
		console.log(`${APPLY ? 'write' : 'would write'}  ${date}  ${page} / ${hardware}  ${line}`);
		if (!APPLY) continue;
		await RobotArmChange.create({ _id, at: new Date(date.includes('T') ? date : `${date}T12:00:00Z`), page, hardware, key, target, oldValue, newValue, unit, source, line, note, details: { backfill: true }, changedBy: null });
		written++;
	}
	console.log(`${ROWS.length} rows: ${present} already present, ${written} written${APPLY ? '' : ' (dry run; add --apply)'}.`);
	await mongoose.disconnect();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
