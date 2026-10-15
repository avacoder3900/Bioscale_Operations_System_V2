/**
 * Auto-grading for the two "does everything work" validation tests
 * (2026-10-06, per Alejandro): Optical Bench and Blank Cartridge.
 *
 * Both used to be capture-only — a run turned the dot green whatever it
 * contained. These rules turn a run into pass / fail with plain reasons, so a
 * unit with a dead laser or a run that published no data gets kicked out at
 * the cheap stage instead of being discovered later.
 *
 * Pure functions over the stored data; nothing is written back. Thresholds
 * were set from production on 2026-10-06:
 *   - blank runs: good runs carry 126 readings (42 positions × 3 channels) and
 *     a per-channel mean laser_output of 733–830; failed runs arrived empty.
 *   - bench laser reads: photodiode 740–836 on every channel of every unit;
 *     dark reads: photodiode 0, bands 0–13.
 * The floors sit well below the good fleet and well above "off".
 */

export type AutoVerdict = 'pass' | 'fail' | 'incomplete';

export interface Graded {
	verdict: AutoVerdict;
	reasons: string[];
}

export const CHANNELS = ['A', 'B', 'C'] as const;
export const BANDS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'clear', 'nir'] as const;
const BAND_LABEL = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'Clear', 'NIR'];

export const BLANK_CRITERIA = {
	/** One full scan: 42 positions × 3 channels. */
	fullScanReadings: 126,
	readingsPerChannel: 42,
	/** Mean laser_output per channel below this = the laser did not come on. Good fleet: 733–830. */
	laserOutputMin: 500
} as const;

export const BENCH_CRITERIA = {
	/** Laser read photodiode below this = laser off / weak / misaligned. Good fleet: 740–836. */
	laserPdMin: 500,
	/** Dark read photodiode above this = laser stuck on or light leaking in. Good fleet: 0. */
	darkPdMax: 50
} as const;

const num = (v: unknown): number | null => {
	const n = typeof v === 'number' ? v : Number(v);
	return v == null || v === '' || !Number.isFinite(n) ? null : n;
};

export interface BlankChannelSummary {
	channel: (typeof CHANNELS)[number];
	n: number;
	/** Mean laser_output over the channel's reads; null when the field is absent. */
	laserOutput: number | null;
	/** Bands whose total over the whole channel is 0 (or missing). */
	emptyBands: string[];
}

/** Grade one blank-cartridge run from its stored readings. */
export function gradeBlankRun(readings: unknown, numberOfReadings?: number | null): Graded & { channels: BlankChannelSummary[] } {
	const rows = (Array.isArray(readings) ? readings : []).filter(
		(r): r is Record<string, unknown> => !!r && typeof r === 'object'
	);
	const reasons: string[] = [];
	const total = rows.length || (num(numberOfReadings) ?? 0);

	const channels: BlankChannelSummary[] = CHANNELS.map((channel) => {
		const mine = rows.filter((r) => r.channel === channel);
		const lo = mine.map((r) => num(r.laser_output)).filter((v): v is number => v !== null);
		const emptyBands = BANDS.flatMap((b, i) => (mine.reduce((acc, r) => acc + (num(r[b]) ?? 0), 0) > 0 ? [] : [BAND_LABEL[i]]));
		return {
			channel,
			n: mine.length,
			laserOutput: lo.length ? lo.reduce((a, b) => a + b, 0) / lo.length : null,
			emptyBands
		};
	});

	if (rows.length === 0) {
		return { verdict: 'fail', reasons: ['No data — the run published no readings'], channels };
	}
	if (total < BLANK_CRITERIA.fullScanReadings) {
		reasons.push(`Run cut short — ${total} of ${BLANK_CRITERIA.fullScanReadings} readings`);
	}
	for (const c of channels) {
		if (c.n === 0) {
			reasons.push(`Channel ${c.channel}: no readings`);
			continue;
		}
		if (c.n < BLANK_CRITERIA.readingsPerChannel) {
			reasons.push(`Channel ${c.channel}: ${c.n} of ${BLANK_CRITERIA.readingsPerChannel} positions read`);
		}
		if (c.laserOutput !== null && c.laserOutput < BLANK_CRITERIA.laserOutputMin) {
			reasons.push(`Channel ${c.channel}: laser did not come on (laser output ${Math.round(c.laserOutput)}, needs ≥ ${BLANK_CRITERIA.laserOutputMin})`);
		}
		if (c.emptyBands.length) {
			reasons.push(`Channel ${c.channel}: no signal in ${c.emptyBands.join(', ')}`);
		}
	}
	return { verdict: reasons.length ? 'fail' : 'pass', reasons, channels };
}

interface BenchChannel {
	c?: string;
	pd?: unknown;
	f?: unknown;
}

/**
 * Grade one bench read (the `optical_bench` result JSON). Scans are for
 * finding the laser position, not a check — they return null.
 */
export function gradeBenchRead(type: string, result: unknown): Graded | null {
	if (type !== 'laser' && type !== 'dark') return null;
	const r = (result && typeof result === 'object' ? result : {}) as { ch?: BenchChannel[]; error?: string };
	if (r.error) return { verdict: 'fail', reasons: [`Unit reported: ${r.error}`] };
	const chans = Array.isArray(r.ch) ? r.ch : [];
	const reasons: string[] = [];
	for (const name of CHANNELS) {
		const c = chans.find((x) => x?.c === name);
		if (!c) {
			reasons.push(`Channel ${name}: no data`);
			continue;
		}
		const pd = num(c.pd);
		const f = Array.isArray(c.f) ? c.f.map(num) : [];
		if (type === 'laser') {
			if (pd === null) reasons.push(`Channel ${name}: no photodiode reading`);
			else if (pd < BENCH_CRITERIA.laserPdMin) reasons.push(`Channel ${name}: laser weak or off (photodiode ${pd}, needs ≥ ${BENCH_CRITERIA.laserPdMin})`);
			const dead = BAND_LABEL.filter((_, i) => !f[i]);
			if (f.length < BANDS.length) reasons.push(`Channel ${name}: sensor returned ${f.length} of ${BANDS.length} bands`);
			else if (dead.length) reasons.push(`Channel ${name}: no signal in ${dead.join(', ')}`);
		} else {
			if (pd !== null && pd > BENCH_CRITERIA.darkPdMax) reasons.push(`Channel ${name}: light in the dark read (photodiode ${pd}, must be ≤ ${BENCH_CRITERIA.darkPdMax}) — laser stuck on or a light leak`);
			if (f.length < BANDS.length) reasons.push(`Channel ${name}: sensor returned ${f.length} of ${BANDS.length} bands`);
		}
	}
	return { verdict: reasons.length ? 'fail' : 'pass', reasons };
}

/**
 * A unit's bench verdict from its latest laser read and latest dark read.
 * Both are needed: the laser read proves the light path, the dark read proves
 * the lasers switch off and nothing leaks in.
 */
export function gradeBenchUnit(
	laser: { result: unknown } | null | undefined,
	dark: { result: unknown } | null | undefined
): Graded {
	const l = laser ? gradeBenchRead('laser', laser.result) : null;
	const d = dark ? gradeBenchRead('dark', dark.result) : null;
	const reasons = [...(l?.reasons ?? []), ...(d?.reasons.map((x) => `Dark: ${x}`) ?? [])];
	if (reasons.length) return { verdict: 'fail', reasons };
	const missing = [!l && 'laser read', !d && 'dark read'].filter(Boolean) as string[];
	if (missing.length) return { verdict: 'incomplete', reasons: [`Still needs a ${missing.join(' and a ')}`] };
	return { verdict: 'pass', reasons: [] };
}
