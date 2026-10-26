/**
 * OT2-LOG-1 L5: the daily rollup math over an injected sample array — p95,
 * heartbeat gaps (> 90 s between consecutive daemon samples), relay minutes
 * (direct === false samples × the sampling interval), per-path loss/RTT,
 * direct-call stats and daemon version changes. Pure; no DB.
 */
import { describe, it, expect } from 'vitest';
import {
	computeDailyRollup,
	dayWindow,
	heartbeatGaps,
	p95,
	pathStats,
	relayMinutes,
	yesterdayUtc,
	type SampleRow
} from './rollup';

const T0 = Date.parse('2026-10-25T00:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000);
const daemon = (s: number, extra: Partial<SampleRow> = {}): SampleRow => ({ at: at(s), source: 'daemon', ...extra });
const imac = (s: number, paths: SampleRow['paths']): SampleRow => ({ at: at(s), source: 'imac', paths });

describe('p95', () => {
	it('is null for no values', () => expect(p95([])).toBeNull());
	it('is the only value for one value', () => expect(p95([42])).toBe(42));
	it('nearest-rank: 95th of 1..100 is 95, of 1..20 is 19', () => {
		expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
		expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
	});
	it('does not depend on input order and does not mutate it', () => {
		const v = [9, 1, 5, 3, 7];
		expect(p95(v)).toBe(9);
		expect(v).toEqual([9, 1, 5, 3, 7]);
	});
});

describe('heartbeatGaps', () => {
	it('a steady 60 s cadence has no gaps', () => {
		const samples = Array.from({ length: 10 }, (_, i) => daemon(i * 60));
		expect(heartbeatGaps(samples)).toEqual({ count: 0, maxS: null });
	});
	it('counts every gap > 90 s and keeps the longest', () => {
		// 0, 60, 120 | 420 (300 s gap) | 480, 540 | 700 (160 s gap) | 760
		const samples = [0, 60, 120, 420, 480, 540, 700, 760].map((s) => daemon(s));
		expect(heartbeatGaps(samples)).toEqual({ count: 2, maxS: 300 });
	});
	it('exactly 90 s is not a gap; 91 s is', () => {
		expect(heartbeatGaps([daemon(0), daemon(90)]).count).toBe(0);
		expect(heartbeatGaps([daemon(0), daemon(91)]).count).toBe(1);
	});
	it('ignores imac samples and unsorted input', () => {
		const samples = [daemon(600), imac(100, []), daemon(0), imac(200, []), daemon(300)];
		expect(heartbeatGaps(samples)).toEqual({ count: 2, maxS: 300 });
	});
	it('one or zero daemon samples → no gaps', () => {
		expect(heartbeatGaps([])).toEqual({ count: 0, maxS: null });
		expect(heartbeatGaps([daemon(5)])).toEqual({ count: 0, maxS: null });
	});
});

describe('relayMinutes', () => {
	it('each direct === false daemon sample is one sampling interval', () => {
		const samples = [
			daemon(0, { tailscale: { direct: true } }),
			daemon(60, { tailscale: { direct: false } }),
			daemon(120, { tailscale: { direct: false } }),
			daemon(180, { tailscale: { direct: false } }),
			daemon(240, { tailscale: { direct: true } }),
			daemon(300) // no tailscale block: unknown, not relay
		];
		expect(relayMinutes(samples)).toBe(3);
		expect(relayMinutes(samples, 30)).toBe(2); // 3 × 30 s = 90 s ≈ 2 min
	});
	it('imac samples never count as relay time', () => {
		expect(relayMinutes([{ at: at(0), source: 'imac', tailscale: { direct: false } }])).toBe(0);
	});
});

describe('pathStats', () => {
	it('averages loss and RTT per path, skipping nulls, and keeps the max loss', () => {
		const samples = [
			imac(0, [
				{ name: 'wifi', lossPct: 0, rttMs: 10 },
				{ name: 'wired', lossPct: 0, rttMs: 1 }
			]),
			imac(60, [
				{ name: 'wifi', lossPct: 20, rttMs: 30 },
				{ name: 'wired', lossPct: null, rttMs: null }
			]),
			imac(120, [{ name: 'wifi', lossPct: 10, rttMs: null }])
		];
		expect(pathStats(samples)).toEqual({
			wifi: { n: 3, lossAvg: 10, lossMax: 20, rttAvg: 20 },
			wired: { n: 2, lossAvg: 0, lossMax: 0, rttAvg: 1 }
		});
	});
	it('unknown path names are ignored; no paths → empty object', () => {
		expect(pathStats([imac(0, [{ name: 'bogus', lossPct: 1, rttMs: 1 }])])).toEqual({});
		expect(pathStats([daemon(0)])).toEqual({});
	});
});

describe('computeDailyRollup', () => {
	it('a full day: counts, gaps, relay, poll RTT, direct calls, versions', () => {
		const samples: SampleRow[] = [
			daemon(0, { bims: { pollRttMs: 100 }, daemon: { version: 'v1' }, tailscale: { direct: true } }),
			daemon(60, { bims: { pollRttMs: 200 }, daemon: { version: 'v1' }, tailscale: { direct: false } }),
			daemon(360, { bims: { pollRttMs: 300 }, daemon: { version: 'v2' }, tailscale: { direct: false } }),
			daemon(420, { bims: { pollRttMs: null }, daemon: { version: 'v2' } }),
			imac(30, [{ name: 'tailnet', lossPct: 5, rttMs: 40 }])
		];
		const out = computeDailyRollup({
			samples,
			directCalls: [
				{ ok: true, latencyMs: 50 },
				{ ok: false, latencyMs: 2000 },
				{ ok: true, latencyMs: 70, line: 'queue' },
				{ ok: true, latencyMs: null }
			],
			resyncs: 2,
			bridgeJobErrors: 1
		});
		expect(out).toEqual({
			samples: 5,
			hbGaps: { count: 1, maxS: 300 },
			pollRtt: { avg: 200, p95: 300 },
			relayMin: 2,
			paths: { tailnet: { n: 1, lossAvg: 5, lossMax: 5, rttAvg: 40 } },
			directCalls: { count: 4, errors: 1, p95LatencyMs: 2000, byLine: { tailnet: 3, queue: 1 } },
			firstProbeMisses: 0,
			resyncs: 2,
			bridgeJobErrors: 1,
			daemonVersions: ['v1', 'v2']
		});
	});
	it('an empty day is all zeros and nulls, never NaN', () => {
		const out = computeDailyRollup({ samples: [] });
		expect(out).toEqual({
			samples: 0,
			hbGaps: { count: 0, maxS: null },
			pollRtt: { avg: null, p95: null },
			relayMin: 0,
			paths: {},
			directCalls: { count: 0, errors: 0, p95LatencyMs: null, byLine: { tailnet: 0, queue: 0 } },
			firstProbeMisses: 0,
			resyncs: 0,
			bridgeJobErrors: 0,
			daemonVersions: []
		});
		expect(JSON.stringify(out)).not.toContain('NaN');
	});
	it('is deterministic — the same input twice gives the same document (idempotent re-run)', () => {
		const input = { samples: [daemon(0, { daemon: { version: 'v1' } }), daemon(200)], resyncs: 1 };
		expect(computeDailyRollup(input)).toEqual(computeDailyRollup(input));
	});
});

describe('day helpers', () => {
	it('dayWindow is the UTC [start, end) of a YYYY-MM-DD and rejects junk', () => {
		const w = dayWindow('2026-10-25')!;
		expect(w.start.toISOString()).toBe('2026-10-25T00:00:00.000Z');
		expect(w.end.toISOString()).toBe('2026-10-26T00:00:00.000Z');
		expect(dayWindow('2026-13-01')).toBeNull();
		expect(dayWindow('2026-02-30')).toBeNull();
		expect(dayWindow('yesterday')).toBeNull();
	});
	it('yesterdayUtc crosses month and year boundaries', () => {
		expect(yesterdayUtc(new Date('2026-01-01T00:05:00.000Z'))).toBe('2025-12-31');
		expect(yesterdayUtc(new Date('2026-10-26T23:59:00.000Z'))).toBe('2026-10-25');
	});
});
