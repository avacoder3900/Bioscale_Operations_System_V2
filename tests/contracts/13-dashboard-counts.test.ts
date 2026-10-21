import { describe, it, expect } from 'vitest';
import { unflatten } from 'devalue';
import { appFetch } from '../helpers/client';

// PERF-01 BM-02: dashboard counts come from index scans minus the checked-out carts
// instead of `$nin` collection scans. scripts/verify-dashboard-counts.ts proves the
// numbers equal the old pipelines against production; this checks the pages still
// serve them, consistently, and quickly.

interface Dashboard {
	pipeline: { phase: string; count: number }[];
	totalMfg: number;
	totalVoided: number;
	weeklyProduction: number;
	storageDistribution?: unknown[];
}

async function pageData(path: string): Promise<{ status: number; data: Record<string, unknown>; ms: number }> {
	const started = performance.now();
	const res = await appFetch(`${path.replace(/\/$/, '')}/__data.json`);
	const ms = performance.now() - started;
	const data: Record<string, unknown> = {};
	if (res.ok) {
		const raw = (await res.json()) as { nodes?: ({ type: string; data?: unknown[] } | null)[] };
		for (const node of raw.nodes ?? []) {
			if (node?.type === 'data' && Array.isArray(node.data)) Object.assign(data, unflatten(node.data));
		}
	}
	return { status: res.status, data, ms };
}

const expectConsistent = (d: Dashboard) => {
	expect(typeof d.totalMfg).toBe('number');
	expect(typeof d.totalVoided).toBe('number');
	expect(typeof d.weeklyProduction).toBe('number');
	expect(d.totalMfg).toBeGreaterThan(0);
	const inPipeline = d.pipeline.reduce((sum, p) => sum + p.count, 0);
	expect(inPipeline).toBeLessThanOrEqual(d.totalMfg + d.totalVoided);
	for (const p of d.pipeline) expect(p.count).toBeGreaterThanOrEqual(0);
};

describe('dashboard counts without $nin (PERF-01 BM-02)', () => {
	it('/cartridge-dashboard serves consistent counts in under 2 s', async () => {
		await pageData('/cartridge-dashboard');
		const { status, data, ms } = await pageData('/cartridge-dashboard');
		expect(status).toBe(200);
		expectConsistent(data as unknown as Dashboard);
		expect(Array.isArray(data.storageDistribution)).toBe(true);
		expect(ms).toBeLessThan(2000);
	});

	it('home serves the same counts and no longer computes the unrendered storage block', async () => {
		const [home, dash] = await Promise.all([pageData('/'), pageData('/cartridge-dashboard')]);
		expect(home.status).toBe(200);
		const cd = home.data.cartridgeDashboard as Dashboard;
		expectConsistent(cd);
		expect(cd.storageDistribution).toBeUndefined();
		const d = dash.data as unknown as Dashboard;
		expect(cd.totalMfg).toBe(d.totalMfg);
		expect(cd.totalVoided).toBe(d.totalVoided);
	});
});
