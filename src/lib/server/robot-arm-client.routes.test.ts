import { describe, it, expect, vi, beforeEach } from 'vitest';

// Route selection and the bounded retry in robot-arm-client.ts. The rule that
// matters most: a POST (motion, GPIO, delete) is only re-sent when the failure
// happened before the request could have reached the Pi.

const FUNNEL = 'https://arm-pi.example.ts.net';
const TUNNEL = 'https://some-words.trycloudflare.com';

let tunnelRow: { url: string; registeredAt: Date } | null = null;

vi.mock('$env/dynamic/private', () => ({
	env: { ROBOT_ARM_BASE_URL: FUNNEL, ROBOT_ARM_API_KEY: 'k' }
}));
vi.mock('./db/connection', () => ({ connectDB: async () => {} }));
vi.mock('./db/models', () => ({
	RobotArmEndpoint: { findById: () => ({ lean: async () => tunnelRow }) }
}));

function preConnectError() {
	const cause = Object.assign(
		new Error('Client network socket disconnected before secure TLS connection was established'),
		{ code: 'ECONNRESET' }
	);
	return Object.assign(new TypeError('fetch failed'), { cause });
}

function midRequestError() {
	const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
	return Object.assign(new TypeError('fetch failed'), { cause });
}

function ok(body: unknown) {
	return new Response(JSON.stringify(body), { status: 200 });
}

async function load() {
	vi.resetModules();
	return import('./robot-arm-client');
}

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
	fetchMock.mockReset();
	tunnelRow = { url: TUNNEL, registeredAt: new Date() };
});

describe('robot-arm routes', () => {
	it('tries the tunnel first and falls over to the Funnel on a pre-connect failure', async () => {
		const { robotArmFetch } = await load();
		fetchMock.mockRejectedValueOnce(preConnectError()).mockResolvedValueOnce(ok({ a: 1 }));
		await expect(robotArmFetch('/health')).resolves.toEqual({ a: 1 });
		expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`${TUNNEL}/health`, `${FUNNEL}/health`]);
	});

	it('ignores a stale tunnel registration', async () => {
		tunnelRow = { url: TUNNEL, registeredAt: new Date(Date.now() - 60 * 60 * 1000) };
		const { robotArmFetch } = await load();
		fetchMock.mockResolvedValueOnce(ok({}));
		await robotArmFetch('/health');
		expect(fetchMock.mock.calls[0][0]).toBe(`${FUNNEL}/health`);
	});

	it('re-sends a POST on another route only when it failed before sending', async () => {
		const { robotArmFetch } = await load();
		fetchMock.mockRejectedValueOnce(preConnectError()).mockResolvedValueOnce(ok({ run_id: 'r' }));
		await robotArmFetch('/replay/start', { method: 'POST', body: {} });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('never re-sends a POST that failed mid-request', async () => {
		const { robotArmFetch } = await load();
		fetchMock.mockRejectedValueOnce(midRequestError()).mockResolvedValueOnce(ok({}));
		await expect(robotArmFetch('/gpio/pulse', { method: 'POST', body: {} })).rejects.toThrow('fetch failed');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('treats a Cloudflare 530 as a route failure for any method', async () => {
		const { robotArmFetch } = await load();
		fetchMock
			.mockResolvedValueOnce(new Response('<html>', { status: 530, headers: { 'cf-ray': 'x' } }))
			.mockResolvedValueOnce(ok({ stopped_run_id: null }));
		await robotArmFetch('/sessions/stop', { method: 'POST' });
		expect(fetchMock.mock.calls[1][0]).toBe(`${FUNNEL}/sessions/stop`);
	});

	it('does not retry a POST on a Cloudflare 502 (it may have reached the Pi)', async () => {
		const { robotArmFetch } = await load();
		fetchMock.mockResolvedValueOnce(new Response('bad', { status: 502, headers: { 'cf-ray': 'x' } }));
		await expect(robotArmFetch('/e-stop', { method: 'POST' })).rejects.toThrow('robot-arm 502');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('stops after 3 attempts', async () => {
		const { robotArmFetch } = await load();
		fetchMock.mockRejectedValue(preConnectError());
		await expect(robotArmFetch('/health', { timeoutMs: 5000 })).rejects.toThrow('fetch failed');
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('remembers the route that worked', async () => {
		const { robotArmFetch, currentArmRoute } = await load();
		fetchMock.mockRejectedValueOnce(preConnectError()).mockImplementation(async () => ok({}));
		await robotArmFetch('/health');
		expect(currentArmRoute()).toBe(FUNNEL);
		await robotArmFetch('/health');
		expect(fetchMock.mock.calls[2][0]).toBe(`${FUNNEL}/health`);
	});

	it('passes a real Pi error through without retrying', async () => {
		const { robotArmFetch } = await load();
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'busy' }), { status: 409 }));
		await expect(robotArmFetch('/health')).rejects.toThrow('robot-arm 409: busy');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
