// Optical confirmation analysis — pure, dependency-free, DERIVE-ON-READ only.
// Never writes to the DB. Stats are computed over an ENDPOINT WINDOW = the last
// windowK readings per channel, because readings are a kinetic curve.

export interface OpticalConfig {
	windowK: number;
	cvThreshold: number;
	crossWellCvThreshold: number;
	zThreshold: number;
}

export const DEFAULT_OPTICAL_CONFIG: OpticalConfig = {
	windowK: 10,
	cvThreshold: 15,
	crossWellCvThreshold: 15,
	zThreshold: 2
};

export interface BandStat {
	n: number;
	mean: number;
	sd: number;
	cv: number | null; // PERCENT (sd/mean*100), null if mean===0
}

export interface ChannelAnalysis {
	channel: 'A' | 'B' | 'C';
	n: number;
	windowK: number;
	f3: BandStat;
	f7: BandStat;
	ratio: number | null;
	ratioMode: number | null;
	ratioSd: number | null;
	ratioCv: number | null;
	bandLow: number | null;
	bandHigh: number | null;
	flags: string[];
}

export interface CartridgeAnalysis {
	profileName: string;
	computedAt: string;
	windowK: number;
	channels: ChannelAnalysis[];
	ratioByChannel: { A: number | null; B: number | null; C: number | null };
	crossWellCv: number | null;
	rogueChannel: 'A' | 'B' | 'C' | null;
	warning: boolean;
	reasons: string[];
}

export interface GroupChannelStat {
	channel: 'A' | 'B' | 'C';
	n: number;
	mean: number | null;
	mode: number | null;
	sd: number | null;
	cv: number | null;
	bandLow: number | null;
	bandHigh: number | null;
}

export interface GroupCartridgeRow {
	id: string;
	label: string;
	ratioByChannel: { A: number | null; B: number | null; C: number | null };
	outlierChannels: Array<'A' | 'B' | 'C'>;
	warning: boolean;
}

export interface GroupAnalysis {
	n: number;
	windowK: number;
	channels: GroupChannelStat[];
	cartridges: GroupCartridgeRow[];
	crossCartridgeFlags: string[];
}

const CHANNELS: ReadonlyArray<'A' | 'B' | 'C'> = ['A', 'B', 'C'];
const PROFILE_NAME = 'Single Scan Cortisol';

// ---- internal helpers -------------------------------------------------------

function toNum(value: unknown): number | null {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	let sum = 0;
	for (const v of values) sum += v;
	return sum / values.length;
}

/** Sample SD (n-1). Returns 0 when fewer than 2 values. */
function sampleSD(values: number[]): number {
	if (values.length < 2) return 0;
	const m = mean(values);
	let acc = 0;
	for (const v of values) acc += (v - m) * (v - m);
	return Math.sqrt(acc / (values.length - 1));
}

/** Percent CV = sd/mean*100. null if mean === 0. */
function cvPercent(m: number, sd: number): number | null {
	return m === 0 ? null : (sd / m) * 100;
}

/** Mode of values binned to 2 decimals (toFixed(2)); ties -> numerically lowest; null if empty. */
function mode(values: number[]): number | null {
	if (values.length === 0) return null;
	const counts = new Map<string, number>();
	for (const v of values) {
		const key = v.toFixed(2);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let bestKey: string | null = null;
	let bestCount = -1;
	let bestVal = Infinity;
	for (const [key, count] of counts) {
		const val = Number(key);
		if (count > bestCount || (count === bestCount && val < bestVal)) {
			bestCount = count;
			bestVal = val;
			bestKey = key;
		}
	}
	return bestKey === null ? null : Number(bestKey);
}

function bandStat(values: number[]): BandStat {
	const n = values.length;
	const m = mean(values);
	const sd = sampleSD(values);
	return { n, mean: m, sd, cv: cvPercent(m, sd) };
}

// ---- per-cartridge ----------------------------------------------------------

export function analyzeCartridge(
	readings: unknown[],
	config?: Partial<OpticalConfig>
): CartridgeAnalysis | null {
	if (!Array.isArray(readings) || readings.length === 0) return null;

	const cfg: OpticalConfig = { ...DEFAULT_OPTICAL_CONFIG, ...config };
	const windowK = cfg.windowK;

	const channels: ChannelAnalysis[] = [];
	const ratioByChannel: { A: number | null; B: number | null; C: number | null } = {
		A: null,
		B: null,
		C: null
	};

	for (const channel of CHANNELS) {
		// filter + sort ascending by (number ?? 0), take last windowK
		const forChannel = readings
			.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
			.filter((r) => (r as Record<string, unknown>).channel === channel)
			.sort((a, b) => (toNum(a.number) ?? 0) - (toNum(b.number) ?? 0));
		const window = forChannel.slice(-windowK);
		const n = window.length;

		const f3Vals: number[] = [];
		const f7Vals: number[] = [];
		const ratioEntries: Array<{ v: number; number: number }> = [];

		for (const r of window) {
			const f3 = toNum(r.f3);
			const f7 = toNum(r.f7);
			if (f3 !== null) f3Vals.push(f3);
			if (f7 !== null) f7Vals.push(f7);
			if (f3 !== null && f3 > 0 && f7 !== null) {
				const v = f7 / f3;
				if (Number.isFinite(v)) {
					ratioEntries.push({ v, number: toNum(r.number) ?? 0 });
				}
			}
		}

		const series = ratioEntries.map((e) => e.v);
		const f3Stat = bandStat(f3Vals);
		const f7Stat = bandStat(f7Vals);

		const ratio = series.length > 0 ? mean(series) : null;
		const ratioSd = series.length > 0 ? sampleSD(series) : null;
		const ratioMode = mode(series);
		const ratioCv =
			ratio !== null && ratio !== 0 && ratioSd !== null ? (ratioSd / ratio) * 100 : null;
		const bandLow = ratio !== null && ratioSd !== null ? ratio - ratioSd : null;
		const bandHigh = ratio !== null && ratioSd !== null ? ratio + ratioSd : null;

		const flags: string[] = [];
		if (ratioCv !== null && ratioCv > cfg.cvThreshold) {
			flags.push(`F7/F3 imprecise: CV ${ratioCv.toFixed(0)}% > ${cfg.cvThreshold}%`);
		}
		if (ratio !== null && ratioSd !== null && ratioSd !== 0) {
			for (const e of ratioEntries) {
				const z = (e.v - ratio) / ratioSd;
				if (Math.abs(z) > cfg.zThreshold) {
					flags.push(
						`reading #${e.number}: F7/F3 ${e.v.toFixed(2)} is ${z > 0 ? '+' : ''}${z.toFixed(1)}σ from mean`
					);
				}
			}
		}

		channels.push({
			channel,
			n,
			windowK,
			f3: f3Stat,
			f7: f7Stat,
			ratio,
			ratioMode,
			ratioSd,
			ratioCv,
			bandLow,
			bandHigh,
			flags
		});
		ratioByChannel[channel] = ratio;
	}

	// cross-well
	const finiteRatios = CHANNELS.map((c) => ratioByChannel[c]).filter(
		(v): v is number => v !== null && Number.isFinite(v)
	);
	const crossWellMean = mean(finiteRatios);
	const crossWellSd = sampleSD(finiteRatios);
	const crossWellCv = finiteRatios.length > 0 ? cvPercent(crossWellMean, crossWellSd) : null;

	let rogueChannel: 'A' | 'B' | 'C' | null = null;
	const reasons: string[] = [];
	if (crossWellCv !== null && crossWellCv > cfg.crossWellCvThreshold) {
		// rogue = channel whose ratio is furthest from the mean of the OTHER channels
		let bestDist = -1;
		for (const c of CHANNELS) {
			const rc = ratioByChannel[c];
			if (rc === null || !Number.isFinite(rc)) continue;
			const others = CHANNELS.filter((o) => o !== c)
				.map((o) => ratioByChannel[o])
				.filter((v): v is number => v !== null && Number.isFinite(v));
			if (others.length === 0) continue;
			const dist = Math.abs(rc - mean(others));
			if (dist > bestDist) {
				bestDist = dist;
				rogueChannel = c;
			}
		}
		reasons.push(
			`Channels disagree: F7/F3 varies ${crossWellCv.toFixed(0)}% across A/B/C (limit ${cfg.crossWellCvThreshold}%). Channel ${rogueChannel} is the outlier.`
		);
	}

	for (const ch of channels) {
		for (const f of ch.flags) reasons.push(f);
	}

	const warning =
		channels.some((c) => c.flags.length > 0) ||
		(crossWellCv !== null && crossWellCv > cfg.crossWellCvThreshold);

	return {
		profileName: PROFILE_NAME,
		computedAt: new Date().toISOString(),
		windowK,
		channels,
		ratioByChannel,
		crossWellCv,
		rogueChannel,
		warning,
		reasons
	};
}

// ---- group (multi-cartridge) ------------------------------------------------

export function analyzeGroup(
	items: Array<{ id: string; label?: string; readings: unknown[] }>,
	config?: Partial<OpticalConfig>
): GroupAnalysis {
	const cfg: OpticalConfig = { ...DEFAULT_OPTICAL_CONFIG, ...config };
	const windowK = cfg.windowK;

	const rows: GroupCartridgeRow[] = [];

	for (const item of items) {
		const analysis = analyzeCartridge(item.readings, config);
		const ratioByChannel = analysis
			? analysis.ratioByChannel
			: { A: null, B: null, C: null };
		rows.push({
			id: item.id,
			label: item.label ?? item.id,
			ratioByChannel,
			outlierChannels: [],
			warning: false
		});
	}

	const channels: GroupChannelStat[] = [];
	const crossCartridgeFlags: string[] = [];

	for (const c of CHANNELS) {
		const finite = rows
			.map((r) => r.ratioByChannel[c])
			.filter((v): v is number => v !== null && Number.isFinite(v));
		const cn = finite.length;
		const m = cn > 0 ? mean(finite) : null;
		const sd = cn > 0 ? sampleSD(finite) : null;
		const md = mode(finite);
		const cv = m !== null && sd !== null ? cvPercent(m, sd) : null;
		const bandLow = m !== null && sd !== null ? m - sd : null;
		const bandHigh = m !== null && sd !== null ? m + sd : null;

		channels.push({
			channel: c,
			n: cn,
			mean: m,
			mode: md,
			sd,
			cv,
			bandLow,
			bandHigh
		});

		// outlier detection per cartridge on this channel (only when sd > 0)
		if (sd !== null && sd > 0 && bandLow !== null && bandHigh !== null) {
			for (const row of rows) {
				const rc = row.ratioByChannel[c];
				if (rc !== null && Number.isFinite(rc) && (rc < bandLow || rc > bandHigh)) {
					row.outlierChannels.push(c);
					row.warning = true;
				}
			}
		}

		if (cv !== null && cv > cfg.cvThreshold) {
			crossCartridgeFlags.push(
				`Channel ${c}: F7/F3 varies ${cv.toFixed(0)}% across the ${cn} cartridges (limit ${cfg.cvThreshold}%)`
			);
		}
	}

	return {
		n: rows.length,
		windowK,
		channels,
		cartridges: rows,
		crossCartridgeFlags
	};
}
