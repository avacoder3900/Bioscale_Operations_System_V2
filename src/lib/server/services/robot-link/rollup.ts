/**
 * Daily connectivity rollup math (OT2-LOG-1 L5). Pure: the cron route
 * (/api/cron/robot-link-daily) loads one robot's day of robot_link_samples,
 * ot2_direct_calls and audit_log counts and hands them here; the result is
 * the robot_link_daily document body.
 *
 * Definitions:
 *  - heartbeat gap: > HB_GAP_S seconds between two consecutive daemon samples
 *    (daemon samples are ≤ 1/min, so a healthy day has gaps of ~60 s).
 *  - relay minutes: daemon samples with tailscale.direct === false, each
 *    standing for one sampling interval (SAMPLE_INTERVAL_S).
 *  - p95: nearest-rank on the sorted values.
 */

export const HB_GAP_S = 90;
export const SAMPLE_INTERVAL_S = 60;
export const PATH_NAMES = ['wifi', 'wired', 'tailnet'] as const;
export type PathName = (typeof PATH_NAMES)[number];

export interface SampleRow {
	at: Date | string;
	source: 'daemon' | 'imac';
	tailscale?: { direct?: boolean | null } | null;
	bims?: { pollRttMs?: number | null } | null;
	daemon?: { version?: string | null } | null;
	paths?: Array<{ name: string; lossPct?: number | null; rttMs?: number | null }> | null;
}

export interface DirectCallRow {
	ok?: boolean | null;
	latencyMs?: number | null;
	/** Not stored today (Ot2DirectCall has no line field); absent = tailnet. */
	line?: string | null;
}

export interface PathStats {
	n: number;
	lossAvg: number | null;
	lossMax: number | null;
	rttAvg: number | null;
}

export interface DailyRollup {
	samples: number;
	hbGaps: { count: number; maxS: number | null };
	pollRtt: { avg: number | null; p95: number | null };
	relayMin: number;
	paths: Partial<Record<PathName, PathStats>>;
	directCalls: { count: number; errors: number; p95LatencyMs: number | null; byLine: { tailnet: number; queue: number } };
	firstProbeMisses: number;
	resyncs: number;
	bridgeJobErrors: number;
	daemonVersions: string[];
}

export interface RollupInput {
	samples: SampleRow[];
	directCalls?: DirectCallRow[];
	resyncs?: number;
	bridgeJobErrors?: number;
	firstProbeMisses?: number;
	sampleIntervalS?: number;
	hbGapS?: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Nearest-rank p95; null for an empty list. */
export function p95(values: number[]): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.max(1, Math.ceil(0.95 * sorted.length));
	return sorted[rank - 1];
}

const avg = (values: number[]): number | null => (values.length ? round1(values.reduce((a, b) => a + b, 0) / values.length) : null);

const ms = (at: Date | string) => new Date(at).getTime();

/** Gaps > hbGapS between consecutive daemon samples (sorted by `at`). */
export function heartbeatGaps(samples: SampleRow[], hbGapS = HB_GAP_S): { count: number; maxS: number | null } {
	const times = samples
		.filter((s) => s.source === 'daemon')
		.map((s) => ms(s.at))
		.filter((t) => Number.isFinite(t))
		.sort((a, b) => a - b);
	let count = 0;
	let maxS: number | null = null;
	for (let i = 1; i < times.length; i++) {
		const gapS = (times[i] - times[i - 1]) / 1000;
		if (gapS > hbGapS) {
			count++;
			maxS = maxS == null ? round1(gapS) : Math.max(maxS, round1(gapS));
		}
	}
	return { count, maxS };
}

/** Minutes on a DERP relay: daemon samples with tailscale.direct === false × the sampling interval. */
export function relayMinutes(samples: SampleRow[], sampleIntervalS = SAMPLE_INTERVAL_S): number {
	const n = samples.filter((s) => s.source === 'daemon' && s.tailscale?.direct === false).length;
	return Math.round((n * sampleIntervalS) / 60);
}

export function pathStats(samples: SampleRow[]): Partial<Record<PathName, PathStats>> {
	const acc: Record<PathName, { n: number; loss: number[]; rtt: number[] }> = {
		wifi: { n: 0, loss: [], rtt: [] },
		wired: { n: 0, loss: [], rtt: [] },
		tailnet: { n: 0, loss: [], rtt: [] }
	};
	for (const s of samples) {
		for (const p of s.paths ?? []) {
			if (!(PATH_NAMES as readonly string[]).includes(p.name)) continue;
			const a = acc[p.name as PathName];
			a.n++;
			if (isNum(p.lossPct)) a.loss.push(p.lossPct);
			if (isNum(p.rttMs)) a.rtt.push(p.rttMs);
		}
	}
	const out: Partial<Record<PathName, PathStats>> = {};
	for (const name of PATH_NAMES) {
		const a = acc[name];
		if (!a.n) continue;
		out[name] = { n: a.n, lossAvg: avg(a.loss), lossMax: a.loss.length ? Math.max(...a.loss) : null, rttAvg: avg(a.rtt) };
	}
	return out;
}

export function computeDailyRollup(input: RollupInput): DailyRollup {
	const samples = input.samples ?? [];
	const calls = input.directCalls ?? [];
	const daemonSamples = samples.filter((s) => s.source === 'daemon');

	const rtts = daemonSamples.map((s) => s.bims?.pollRttMs).filter(isNum);
	const latencies = calls.map((c) => c.latencyMs).filter(isNum);

	const daemonVersions: string[] = [];
	for (const s of daemonSamples) {
		const v = s.daemon?.version;
		if (typeof v === 'string' && v && !daemonVersions.includes(v)) daemonVersions.push(v);
	}

	let queue = 0;
	for (const c of calls) if (c.line === 'queue') queue++;

	return {
		samples: samples.length,
		hbGaps: heartbeatGaps(samples, input.hbGapS),
		pollRtt: { avg: avg(rtts), p95: p95(rtts) },
		relayMin: relayMinutes(samples, input.sampleIntervalS),
		paths: pathStats(samples),
		directCalls: {
			count: calls.length,
			errors: calls.filter((c) => c.ok === false).length,
			p95LatencyMs: p95(latencies),
			byLine: { tailnet: calls.length - queue, queue }
		},
		firstProbeMisses: input.firstProbeMisses ?? 0,
		resyncs: input.resyncs ?? 0,
		bridgeJobErrors: input.bridgeJobErrors ?? 0,
		daemonVersions
	};
}

/** 'YYYY-MM-DD' (UTC) → [start, end) Date pair; null when malformed. */
export function dayWindow(day: string): { start: Date; end: Date } | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
	const start = new Date(`${day}T00:00:00.000Z`);
	if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== day) return null;
	return { start, end: new Date(start.getTime() + 24 * 3600_000) };
}

/** Yesterday, UTC, as 'YYYY-MM-DD'. */
export function yesterdayUtc(now = new Date()): string {
	return new Date(now.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
}
