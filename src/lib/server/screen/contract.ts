/**
 * Device → BIMS contract for the one-button SCREEN (firmware v102,
 * brevitest-device Docs/DEVICE_SCREEN_PIPELINE_PLAN.md §2.3; ids as the v102
 * firmware emits them, 2026-10-13).
 *
 * The device runs its self-test table in levels and publishes `bioscale/screen`
 * events — one or more parts per level (each ≤ ~1000 bytes) — then a summary
 * with lvl 9:
 *
 *   {"v":1,"fw":102,"run":7,"lvl":1,"part":1,"of":2,
 *    "t":[["home1","P",812,null,812],["homerep1","W",-100,100,2410,"um"],…]}
 *   {"v":1,"fw":102,"run":7,"lvl":9,"pass":31,"fail":0,"warn":2,"skip":1,"info":4,
 *    "ms":4312000,"levels":"0123","reps":3,"assay":"AE9DE09B","aborted":""}
 *
 * A row is [id, status, value, limit, ms, note?]. status: P pass · F fail ·
 * W warn (value recorded, limit owned by BIMS) · S skip (note says why) ·
 * I info. value is a number or a short string. `run` is the device's per-boot
 * screen sequence; (device, run) identifies one screen. Repeated tests carry
 * the rep number as a trailing digit (mem1, mem2, homerep3, lsrA_f7{r}); BIMS
 * criteria may be keyed by the bare id (homerep) or the exact id (homerep2).
 *
 * Level 2 (assay motion): ONE event per run, part = run index, of = reps, ids
 * run{N}_heat (s waited for the heater), run{N}_assay (only on failure),
 * run{N}_err, run{N}_hits, run{N}_first, run{N}_home_ms, run{N}_travel,
 * run{N}_dur_s, run{N}_hitms (value = hit count, note = "ms,ms"), run{N}_temp
 * (heater °C×10 at the end), run{N}_reads, run{N}_done (P/F, note "cancelled").
 *
 * An abort appends a row id "abort" (F, note = reason) to the level that was
 * running; the lvl 9 summary then carries "aborted":"<reason>".
 *
 * Nothing here touches the DB; ingest.ts does.
 */

export type ScreenRowStatus = 'P' | 'F' | 'W' | 'S' | 'I';
export const SCREEN_STATUS_LABEL: Record<ScreenRowStatus, string> = {
	P: 'pass',
	F: 'fail',
	W: 'warn',
	S: 'skip',
	I: 'info'
};

export interface ScreenRow {
	id: string;
	status: ScreenRowStatus;
	value: number | string | null;
	limit: number | null;
	ms: number;
	note: string | null;
	/** Which level event carried it. */
	level: number;
	/** Which part (for level 2: the run index). */
	part: number;
}

export interface ScreenLevelEvent {
	v: number;
	fw: number;
	run: number;
	lvl: number;
	part: number;
	of: number;
	rows: ScreenRow[];
}

export interface ScreenSummaryEvent {
	v: number;
	fw: number;
	run: number;
	lvl: 9;
	pass: number;
	fail: number;
	warn: number;
	skip: number;
	info: number;
	ms: number;
	levels: string;
	reps: number;
	assay: string | null;
	aborted: string | null;
	/** A refused start writes {"lvl":9,"error":…} to the variable only; kept for completeness. */
	error: string | null;
}

export type ScreenEvent = ScreenLevelEvent | ScreenSummaryEvent;

export const SCREEN_LEVEL_NAMES: Record<number, string> = {
	0: 'Static',
	1: 'Actuators & sensors',
	2: 'Assay motion ×N',
	3: 'Cloud path'
};

/** Strip a trailing rep digit: "homerep2" → "homerep", "lsrA_f7_3"? no — ids end in the digit directly. */
export function baseTestId(id: string): string {
	if (/^run\d+_/.test(id)) return id; // run rows keep their run number
	return id.replace(/(\D)\d$/, '$1');
}

/** Human labels for the bare test ids the firmware emits; unknown ids fall back to the id. */
export const SCREEN_TEST_LABELS: Record<string, string> = {
	// level 0
	fw: 'Firmware / Device OS',
	reset: 'Reset reason (System.resetReason)',
	uptime: 'Uptime',
	eeprom: 'EEPROM checkpoint',
	fs: 'Filesystem probe',
	fs_val: '/validation file count',
	fs_assay: '/assay file count',
	fs_sweep: '/sweep file count',
	assay: 'Production assay on device',
	assay_son: 'Sonic assay on device',
	mem: 'Free RAM',
	detect: 'Cartridge detector (empty)',
	limit0: 'Limit switch at rest',
	therm: 'Thermistor sanity',
	specA: 'Spectrometer A bus',
	specB: 'Spectrometer B bus',
	specC: 'Spectrometer C bus',
	pd0A: 'Photodiode A dark floor',
	pd0B: 'Photodiode B dark floor',
	pd0C: 'Photodiode C dark floor',
	radio: 'Wi-Fi RSSI (dBm)',
	scanner: 'Barcode scanner',
	ble: 'BLE radio',
	// level 1
	wake: 'Motor wake shift',
	home: 'Home time (ms)',
	homerep: 'Home repeat error (µm)',
	travel: 'Full travel',
	hits: 'Mid-move switch hits',
	hits_first: 'First hit (µm)',
	travel_um: 'Travel this level (µm)',
	lsrA: 'Laser A → photodiode (pd − pd0)',
	lsrA_c: 'Laser A clear band',
	lsrA_f1: 'Laser A F1 (405 nm)',
	lsrA_f7: 'Laser A F7',
	drkA: 'Dark A',
	bgA: 'Background A (assay gain)',
	bgA_f7: 'Background A F7',
	lsrB: 'Laser B → photodiode (pd − pd0)',
	lsrB_c: 'Laser B clear band',
	lsrB_f1: 'Laser B F1 (405 nm)',
	lsrB_f7: 'Laser B F7',
	drkB: 'Dark B',
	bgB: 'Background B (assay gain)',
	bgB_f7: 'Background B F7',
	lsrC: 'Laser C → photodiode (pd − pd0)',
	lsrC_c: 'Laser C clear band',
	lsrC_f1: 'Laser C F1 (405 nm)',
	lsrC_f7: 'Laser C F7',
	drkC: 'Dark C',
	bgC: 'Background C (assay gain)',
	bgC_f7: 'Background C F7',
	spec_sat: 'Spectrometer saturation',
	heat_cold: 'Heater time to target (s, cold)',
	heat_start: 'Heater start temperature (°C×10)',
	heat_over: 'Heater overshoot (°C×10)',
	heat_hold: 'Heater hold deviation (°C×10, warm)',
	heat_duty: 'Heater hold duty (%)',
	heat_off: 'Heater off (temperature falls)',
	buzz: 'Buzzer',
	led: 'Status LED',
	// level 3
	cloud: 'Cloud connected',
	sub: 'Subscription registered',
	pending: 'No stuck cloud op',
	ping: 'Cloud round trip (ms)',
	repo: 'Assay repo',
	logup: 'Log upload',
	abort: 'ABORTED'
};

export function screenTestLabel(id: string): string {
	const m = /^run(\d+)_(.+)$/.exec(id);
	if (m) {
		const part: Record<string, string> = {
			heat: 'heater wait (s)',
			assay: 'assay load',
			err: 'end-of-test home error (µm)',
			hits: 'limit hits',
			first: 'first hit (µm)',
			home_ms: 'home time (ms)',
			travel: 'travel (µm)',
			dur_s: 'duration (s)',
			hitms: 'hits (count; times in note)',
			temp: 'heater at end (°C×10)',
			reads: 'readings taken',
			done: 'run completed'
		};
		return `Run ${m[1]} ${part[m[2]] ?? m[2]}`;
	}
	const base = baseTestId(id);
	const rep = base !== id ? id.slice(base.length) : '';
	const label = SCREEN_TEST_LABELS[base] ?? SCREEN_TEST_LABELS[id] ?? id;
	return rep ? `${label} · rep ${rep}` : label;
}

/**
 * What each test measures and how the device judges it, for the full report
 * table. Keyed by bare id (reps stripped) or by the run-row suffix. Mirrors
 * brevitest-device Docs/SCREEN_TEST_CATALOG.md — keep the two in step.
 */
export const SCREEN_TEST_DOCS: Record<string, { what: string; rule: string }> = {
	// level 0
	fw: { what: 'Firmware version; note = Device OS version', rule: 'info' },
	reset: { what: 'System.resetReason() code of the last boot', rule: 'warn if panic / watchdog / brownout / unknown' },
	uptime: { what: 'Seconds since boot; note timeok/notime', rule: 'info' },
	eeprom: { what: 'EEPROM firmware + data-format versions match, no stale running test', rule: 'fail on mismatch or stale uuid' },
	fs: { what: 'Filesystem write/read probe; value = /cache file count', rule: 'fail if the probe fails' },
	fs_val: { what: '/validation file count against the 50-file cap', rule: 'warn within 5 of the cap' },
	fs_assay: { what: '/assay file count', rule: 'info' },
	fs_sweep: { what: '/sweep file count', rule: 'info' },
	assay: { what: 'Production assay BCODE present on disk (note = id)', rule: 'fail if missing' },
	assay_son: { what: 'Sonic assay present on disk (note = id)', rule: 'warn if missing' },
	mem: { what: 'Free RAM, bytes', rule: 'warn below 20000' },
	detect: { what: 'Cartridge detector reads empty', rule: 'fail if a cartridge is inserted' },
	limit0: { what: 'Limit switch state agrees with the stage counter (closed ⇔ position 0)', rule: 'warn if they disagree' },
	therm: { what: 'Thermistor sanity: raw > 0 and 10–60 °C (value °C×10)', rule: 'fail outside; note raw0' },
	specA: { what: 'Spectrometer A power-on + reset over I²C', rule: 'fail on bus error' },
	specB: { what: 'Spectrometer B power-on + reset over I²C', rule: 'fail on bus error' },
	specC: { what: 'Spectrometer C power-on + reset over I²C', rule: 'fail on bus error' },
	pd0A: { what: 'Photodiode A dark floor, laser off', rule: 'info' },
	pd0B: { what: 'Photodiode B dark floor, laser off', rule: 'info' },
	pd0C: { what: 'Photodiode C dark floor, laser off', rule: 'info' },
	radio: { what: 'Wi-Fi RSSI, dBm; note cloud / wifi / down', rule: 'fail if not cloud-connected, warn below −75 dBm' },
	scanner: { what: 'Barcode scanner invoked once; value = result type; note code/nocode', rule: 'info' },
	ble: { what: 'BLE scan device count; note magfound if the magnetometer tool answered', rule: 'info' },
	// level 1
	wake: { what: 'Motor wake shift: expected − measured home after wake, µm', rule: 'info; note notfound' },
	home: { what: 'Home found; value = time to home, ms', rule: 'fail if the switch is not found' },
	homerep: { what: 'Home repeatability: go to 21000 µm and re-home; value = error, µm', rule: 'fail not found, warn beyond ±150' },
	travel: { what: 'Full travel to 39500 µm and back; value = home error, µm', rule: 'fail if clipped / not found, warn beyond ±150' },
	lsrA: { what: 'Laser A into the photodiode at the bench position: pd − pd0', rule: 'fail below 50 or on sensor error' },
	lsrB: { what: 'Laser B into the photodiode at the bench position: pd − pd0', rule: 'fail below 50 or on sensor error' },
	lsrC: { what: 'Laser C into the photodiode at the bench position: pd − pd0', rule: 'fail below 50 or on sensor error' },
	lsrA_c: { what: 'Spectrometer A clear band, laser on', rule: 'warn at 62000 (saturation)' },
	lsrB_c: { what: 'Spectrometer B clear band, laser on', rule: 'warn at 62000 (saturation)' },
	lsrC_c: { what: 'Spectrometer C clear band, laser on', rule: 'warn at 62000 (saturation)' },
	lsrA_f1: { what: 'Spectrometer A F1 (405 nm), laser on', rule: 'info' },
	lsrB_f1: { what: 'Spectrometer B F1 (405 nm), laser on', rule: 'info' },
	lsrC_f1: { what: 'Spectrometer C F1 (405 nm), laser on', rule: 'info' },
	lsrA_f7: { what: 'Spectrometer A F7, laser on', rule: 'info' },
	lsrB_f7: { what: 'Spectrometer B F7, laser on', rule: 'info' },
	lsrC_f7: { what: 'Spectrometer C F7, laser on', rule: 'info' },
	drkA: { what: 'Clear band A, laser off, bench gain', rule: 'fail on sensor error' },
	drkB: { what: 'Clear band B, laser off, bench gain', rule: 'fail on sensor error' },
	drkC: { what: 'Clear band C, laser off, bench gain', rule: 'fail on sensor error' },
	bgA: { what: 'Empty-slot background A: clear band at assay gain, laser off', rule: 'fail on sensor error' },
	bgB: { what: 'Empty-slot background B: clear band at assay gain, laser off', rule: 'fail on sensor error' },
	bgC: { what: 'Empty-slot background C: clear band at assay gain, laser off', rule: 'fail on sensor error' },
	bgA_f7: { what: 'Background A, F7 band at assay gain', rule: 'info' },
	bgB_f7: { what: 'Background B, F7 band at assay gain', rule: 'info' },
	bgC_f7: { what: 'Background C, F7 band at assay gain', rule: 'info' },
	spec_sat: { what: 'Any spectrometer saturated during the rep', rule: 'warn if yes' },
	hits: { what: 'Mid-move limit-switch hits during the level', rule: 'fail if any' },
	hits_first: { what: 'Position of the first mid-move hit, µm (only when hits > 0)', rule: 'info' },
	travel_um: { what: 'Stage travel during this level (odometer), µm', rule: 'info' },
	heat_cold: { what: 'Cold start: seconds to reach the target (only when the heater started > 5 °C below it)', rule: 'fail if not reached in 240 s' },
	heat_start: { what: 'Heater temperature at the start of the hold, °C×10', rule: 'info' },
	heat_over: { what: 'Overshoot above target on a cold start, °C×10', rule: 'info' },
	heat_hold: { what: 'Max deviation from target over a 60 s hold, °C×10', rule: 'warn above 20 (2 °C)' },
	heat_duty: { what: 'Mean heater power over the hold, %', rule: 'info' },
	heat_off: { what: 'Heater commanded off for 30 s: temperature change, °C×10; note pinon', rule: 'fail if it rose more than 0.5 °C' },
	buzz: { what: 'Buzzer sounded for 500 ms', rule: 'operator confirms in BIMS' },
	led: { what: 'Status LED pattern shown', rule: 'operator confirms in BIMS' },
	// level 3
	cloud: { what: 'Emitted instead of a ping when the device is not cloud-connected', rule: 'fail (offline)' },
	sub: { what: 'Hook-response subscription registered at boot', rule: 'fail if not' },
	pending: { what: 'No cloud operation stuck in flight', rule: 'fail if one is' },
	ping: { what: 'Publish bioscale/ping and wait for the BIMS hook-response with the nonce; value = round trip, ms', rule: 'fail on 15 s timeout or publish failure, warn above 5000' },
	repo: { what: 'Assay repository check', rule: 'skipped (not built yet)' },
	logup: { what: 'Session log upload queued for after the screen', rule: 'info' },
	abort: { what: 'The screen was aborted; note = reason', rule: 'fail' }
};

const RUN_ROW_DOCS: Record<string, { what: string; rule: string }> = {
	heat: { what: 'Seconds waited for the heater before the run', rule: 'warn if not ready within 300 s' },
	assay: { what: 'Assay BCODE missing from disk', rule: 'fail' },
	err: { what: 'End-of-test home error: expected − measured after the final home, µm', rule: 'fail not found, warn beyond ±150' },
	hits: { what: 'Limit-switch hits during the run', rule: 'fail if any' },
	first: { what: 'Position of the first hit, µm (−1 = none)', rule: 'info' },
	home_ms: { what: 'Time of the final home, ms', rule: 'info' },
	travel: { what: 'Stage travel during the run (odometer), µm', rule: 'info' },
	dur_s: { what: 'Run duration, s', rule: 'info' },
	hitms: { what: 'Hit count; note = hit times, ms', rule: 'info' },
	temp: { what: 'Heater at the end of the run, °C×10', rule: 'info' },
	reads: { what: 'Readings taken', rule: 'info' },
	done: { what: 'Run completed (not cancelled)', rule: 'fail if cancelled' }
};

/** {what, rule} for any emitted id; unknown ids get an empty doc. */
export function screenTestDoc(id: string): { what: string; rule: string } {
	const m = /^run(\d+)_(.+)$/.exec(id);
	if (m) return RUN_ROW_DOCS[m[2]] ?? { what: '', rule: '' };
	return SCREEN_TEST_DOCS[baseTestId(id)] ?? SCREEN_TEST_DOCS[id] ?? { what: '', rule: '' };
}

/** Rep number carried by the id ("homerep2" → 2), or null. Run rows return the run index. */
export function screenTestRep(id: string): number | null {
	const m = /^run(\d+)_/.exec(id);
	if (m) return Number(m[1]);
	const base = baseTestId(id);
	return base !== id ? Number(id.slice(base.length)) : null;
}

/** Parse one published event body (string or already-parsed object). Null when it is not a screen event. */
export function parseScreenEvent(data: unknown): ScreenEvent | null {
	let obj: any = data;
	if (typeof data === 'string') {
		try {
			obj = JSON.parse(data);
		} catch {
			return null;
		}
	}
	if (!obj || typeof obj !== 'object') return null;
	const lvl = Number(obj.lvl);
	if (!Number.isFinite(lvl)) return null;
	const run = Number(obj.run);
	const fw = Number(obj.fw) || 0;
	const v = Number(obj.v) || 1;
	if (lvl === 9) {
		if (!Number.isFinite(run) && !obj.error) return null;
		return {
			v,
			fw,
			run: Number.isFinite(run) ? run : -1,
			lvl: 9,
			pass: Number(obj.pass) || 0,
			fail: Number(obj.fail) || 0,
			warn: Number(obj.warn) || 0,
			skip: Number(obj.skip) || 0,
			info: Number(obj.info) || 0,
			ms: Number(obj.ms) || 0,
			levels: typeof obj.levels === 'string' ? obj.levels : '',
			reps: Number(obj.reps) || 0,
			assay: typeof obj.assay === 'string' && obj.assay ? obj.assay : null,
			aborted: typeof obj.aborted === 'string' && obj.aborted ? obj.aborted : null,
			error: typeof obj.error === 'string' && obj.error ? obj.error : null
		};
	}
	if (!Number.isFinite(run)) return null;
	const part = Number(obj.part) || 1;
	const rowsIn = Array.isArray(obj.t) ? obj.t : [];
	const rows: ScreenRow[] = [];
	for (const r of rowsIn) {
		if (!Array.isArray(r) || r.length < 2) continue;
		const status = String(r[1]).toUpperCase().slice(0, 1) as ScreenRowStatus;
		if (!['P', 'F', 'W', 'S', 'I'].includes(status)) continue;
		const rawVal = r[2];
		const value = rawVal == null ? null : typeof rawVal === 'number' ? rawVal : String(rawVal);
		const limit = r[3] == null || r[3] === '' ? null : Number(r[3]);
		rows.push({
			id: String(r[0]),
			status,
			value,
			limit: limit != null && Number.isFinite(limit) ? limit : null,
			ms: Number(r[4]) || 0,
			note: r[5] != null ? String(r[5]) : null,
			level: lvl,
			part
		});
	}
	return { v, fw, run, lvl, part, of: Number(obj.of) || 1, rows };
}

// ---- criteria -------------------------------------------------------------

/**
 * BIMS-owned limits per test id (Integration doc type 'screen_criteria',
 * field `criteria`). The device's own P/F is kept as `deviceStatus`; BIMS
 * recomputes a status when a criterion exists for the id — exact id first
 * ("homerep2"), then the bare id ("homerep"), then run rows by their suffix
 * ("run_err" applies to run1_err, run2_err, …):
 *   { "homerep": { "min": -150, "max": 150 }, "lsrA": { "min": 300 },
 *     "run_err": { "min": -200, "max": 200 }, "ble": { "ignore": true } }
 * A row with no criterion keeps the device status.
 */
export interface ScreenCriterion {
	min?: number | null;
	max?: number | null;
	/** When set, a breach is a WARN rather than a FAIL. */
	warnOnly?: boolean;
	ignore?: boolean;
	label?: string;
}
export type ScreenCriteria = Record<string, ScreenCriterion>;

export function criterionFor(id: string, criteria: ScreenCriteria | null | undefined): ScreenCriterion | null {
	if (!criteria) return null;
	if (criteria[id]) return criteria[id];
	const base = baseTestId(id);
	if (criteria[base]) return criteria[base];
	const m = /^run\d+_(.+)$/.exec(id);
	if (m && criteria[`run_${m[1]}`]) return criteria[`run_${m[1]}`];
	return null;
}

export interface EvaluatedScreenRow extends ScreenRow {
	deviceStatus: ScreenRowStatus;
	/** The status after BIMS criteria. */
	finalStatus: ScreenRowStatus;
	criterion: ScreenCriterion | null;
	label: string;
}

export function evaluateScreenRows(rows: ScreenRow[], criteria: ScreenCriteria | null | undefined): EvaluatedScreenRow[] {
	return rows.map((row) => {
		const c = criterionFor(row.id, criteria);
		let final: ScreenRowStatus = row.status;
		if (c && !c.ignore && typeof row.value === 'number' && row.status !== 'S') {
			const below = c.min != null && row.value < c.min;
			const above = c.max != null && row.value > c.max;
			if (below || above) final = c.warnOnly ? 'W' : 'F';
			else if (row.status === 'W' || row.status === 'F') final = 'P'; // BIMS limit overrides the device's guess
		} else if (c?.ignore) {
			final = 'I';
		}
		if (row.id === 'abort') final = 'F';
		return { ...row, deviceStatus: row.status, finalStatus: final, criterion: c, label: screenTestLabel(row.id) };
	});
}

export interface ScreenCounts {
	pass: number;
	fail: number;
	warn: number;
	skip: number;
	info: number;
}

export function countStatuses(rows: Array<{ finalStatus: ScreenRowStatus }>): ScreenCounts {
	const c: ScreenCounts = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0 };
	for (const r of rows) {
		if (r.finalStatus === 'P') c.pass++;
		else if (r.finalStatus === 'F') c.fail++;
		else if (r.finalStatus === 'W') c.warn++;
		else if (r.finalStatus === 'S') c.skip++;
		else c.info++;
	}
	return c;
}

/**
 * The numeric tests worth trending per unit (history sparklines). A bare id
 * averages its reps (homerep1..3 → one point); run rows are listed per run.
 */
export const SCREEN_TREND_IDS: Array<{ id: string; label: string; unit: string }> = [
	{ id: 'homerep', label: 'Home repeat error', unit: 'µm' },
	{ id: 'home', label: 'Home time', unit: 'ms' },
	{ id: 'wake', label: 'Motor wake shift', unit: 'µm' },
	{ id: 'lsrA', label: 'Laser A pd', unit: '' },
	{ id: 'lsrB', label: 'Laser B pd', unit: '' },
	{ id: 'lsrC', label: 'Laser C pd', unit: '' },
	{ id: 'lsrA_f1', label: 'Laser A F1', unit: '' },
	{ id: 'heat_cold', label: 'Heater time to target', unit: 's' },
	{ id: 'heat_hold', label: 'Heater hold deviation', unit: '°C×10' },
	{ id: 'heat_duty', label: 'Heater hold duty', unit: '%' },
	{ id: 'radio', label: 'RSSI', unit: 'dBm' },
	{ id: 'ping', label: 'Ping latency', unit: 'ms' },
	{ id: 'mem', label: 'Free RAM', unit: 'B' },
	{ id: 'run1_err', label: 'Run 1 home error', unit: 'µm' },
	{ id: 'run2_err', label: 'Run 2 home error', unit: 'µm' },
	{ id: 'run3_err', label: 'Run 3 home error', unit: 'µm' },
	{ id: 'run1_travel', label: 'Run 1 travel', unit: 'µm' },
	{ id: 'run1_dur_s', label: 'Run 1 duration', unit: 's' },
	{ id: 'run1_temp', label: 'Run 1 heater at end', unit: '°C×10' }
];

/** Numeric value of a trend id in one screen: the exact row, or the mean over its reps. */
export function trendValue(rows: Array<{ id: string; value: number | string | null }>, id: string): number | null {
	const exact = rows.find((r) => r.id === id && typeof r.value === 'number');
	if (exact) return exact.value as number;
	const reps = rows.filter((r) => baseTestId(r.id) === id && typeof r.value === 'number').map((r) => r.value as number);
	if (!reps.length) return null;
	return Math.round((reps.reduce((s, v) => s + v, 0) / reps.length) * 100) / 100;
}
