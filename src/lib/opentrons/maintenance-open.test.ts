import { describe, expect, it } from 'vitest';
import { openMaintenanceRun } from './ot2-protocol';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function transport(posts: Response[], current: Response) {
	const calls: string[] = [];
	return {
		calls,
		t: {
			get: async (path: string) => (calls.push(`GET ${path}`), current.clone()),
			post: async (path: string) => (calls.push(`POST ${path}`), posts.shift()!),
			delete: async (path: string) => (calls.push(`DELETE ${path}`), json(200, {}))
		} as any
	};
}

describe('openMaintenanceRun', () => {
	it('retries once after a robot-server 500 (B07 2026-11-06)', async () => {
		const { t, calls } = transport([json(500, { message: 'TaskGroup' }), json(201, { data: { id: 'm2' } })], json(404, {}));
		expect(await openMaintenanceRun(t)).toEqual({ runId: 'm2' });
		expect(calls).toEqual(['POST /maintenance_runs', 'GET /maintenance_runs/current_run', 'POST /maintenance_runs']);
	});

	it('takes the run the failed attempt opened anyway', async () => {
		const { t, calls } = transport([json(500, {})], json(200, { data: { id: 'm1' } }));
		expect(await openMaintenanceRun(t)).toEqual({ runId: 'm1' });
		expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
	});

	it('still fails on a second 500', async () => {
		const { t } = transport([json(500, {}), json(500, { errors: [{ detail: 'still broken' }] })], json(404, {}));
		await expect(openMaintenanceRun(t)).rejects.toThrow('still broken');
	});
});
