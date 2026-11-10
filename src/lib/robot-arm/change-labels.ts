/**
 * Robot arm change log — the labels (2026-11-06).
 *
 * Every change to the arm, its Pi or its settings gets two vague labels and
 * one precise label, so the log can be filtered by where or what, and a
 * machine can diff the precise one:
 *
 *   page      where it was done: a BIMS page, the Pi itself, or by hand
 *   hardware  what it touched: a servo, a camera, the conveyor, …
 *   key       one dotted name per setting (servo.p_coefficient, conveyor.pulse_ms,
 *             test.bus_echo), with a target (servo:2, pin:22, camera:arm), the
 *             old and new value and the unit
 *
 * Pure: the browser (the Maintenance page) and the server share these. The
 * writes live in $lib/server/robot-arm-change-log.
 */

export const ARM_PAGES = [
	'run',
	'teach',
	'calibrate.arm',
	'calibrate.stage',
	'maintenance.control',
	'maintenance.cleanup',
	'maintenance.jog',
	'maintenance.sync-zero',
	'maintenance.tests',
	/** Maintenance → Movement Log (2026-11-10). */
	'maintenance.moves',
	/** The ARM card in the right rail, on every tab. */
	'arm-card',
	/** The Opentrons lab pages (a protocol deployed from the library), 2026-11-06. */
	'opentrons',
	/** Done on the Pi itself (installs, restarts, Wi-Fi). */
	'pi',
	/** Physical work with no page (cables, wiring, ports). */
	'hand'
] as const;
export type ArmPage = (typeof ARM_PAGES)[number];

export const ARM_HARDWARE = [
	'servo',
	'gripper',
	'leader-arm',
	'camera',
	'depth',
	'vision',
	'solenoid',
	'conveyor',
	'stage',
	'pi',
	'network',
	/** The OT-2 the arm feeds: its protocol, which robot (2026-11-06). */
	'ot2'
] as const;
export type ArmHardware = (typeof ARM_HARDWARE)[number];

/** ui = a BIMS page wrote it; pi = done on the Pi; code = a deploy changed a constant; hand = physical; test = a Maintenance test. */
export const ARM_SOURCES = ['ui', 'pi', 'code', 'hand', 'test'] as const;
export type ArmSource = (typeof ARM_SOURCES)[number];

/** servo.p_coefficient, conveyor.pulse_ms, test.bus_echo, pi.router.thermal: lower case, dotted, at least two parts. */
export const ARM_KEY_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;

export function isArmKey(key: unknown): key is string {
	return typeof key === 'string' && ARM_KEY_RE.test(key);
}

export function isArmPage(v: unknown): v is ArmPage {
	return typeof v === 'string' && (ARM_PAGES as readonly string[]).includes(v);
}

export function isArmHardware(v: unknown): v is ArmHardware {
	return typeof v === 'string' && (ARM_HARDWARE as readonly string[]).includes(v);
}

export function isArmSource(v: unknown): v is ArmSource {
	return typeof v === 'string' && (ARM_SOURCES as readonly string[]).includes(v);
}

export interface ArmChangeLabel {
	page: ArmPage;
	hardware: ArmHardware;
	key: string;
	/** servo:2, pin:22, camera:arm, pose:<id>; null when the key names one thing only. */
	target?: string | null;
	unit?: string | null;
	oldValue?: unknown;
	newValue?: unknown;
}

/** A value as the log prints it. Booleans read On / Off; arrays join; objects are JSON. */
export function formatValue(v: unknown): string {
	if (v === null || v === undefined) return '';
	if (typeof v === 'boolean') return v ? 'On' : 'Off';
	if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
	if (typeof v === 'string') return v;
	if (Array.isArray(v)) return v.map(formatValue).join(', ');
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

/**
 * The precise label on one line:
 *   servo.p_coefficient servo:2 6 -> 16
 *   conveyor.pulse_ms 600 ms
 *   test.bus_echo Pass
 */
export function changeLine(e: ArmChangeLabel): string {
	const parts = [e.key];
	if (e.target) parts.push(e.target);
	const oldV = formatValue(e.oldValue);
	const newV = formatValue(e.newValue);
	const unit = e.unit ? ` ${e.unit}` : '';
	if (oldV && newV) parts.push(`${oldV} -> ${newV}${unit}`);
	else if (newV) parts.push(`${newV}${unit}`);
	else if (oldV) parts.push(`${oldV}${unit} -> `);
	return parts.join(' ');
}

/** Title Case for a label value: 'calibrate.arm' -> 'Calibrate Arm', 'leader-arm' -> 'Leader Arm'. */
export function labelTitle(v: string): string {
	return v
		.split(/[.\-_]/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}
