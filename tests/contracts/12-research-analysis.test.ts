import { describe, it, expect } from 'vitest';
import { appFetch } from '../helpers/client';

const API_KEY = process.env.AGENT_API_KEY || 'bvt_ak_7mXpL9wQzR3nKfY2dHsJ6vTcA8eUgB4x';
const agentHeaders = { 'X-API-Key': API_KEY };

/**
 * /api/agent/research/* proxy contract. When RESEARCH_API_URL is set on the running
 * app the catalog call is a live round-trip; when it is not, the proxy must answer
 * 503 with a clear error (never a stack trace, never a hang).
 */
describe('Research analysis proxy', () => {
	it('rejects requests without the agent key', async () => {
		const res = await appFetch('/api/agent/research/analysis/catalog');
		expect(res.status).toBe(401);
	});

	it('refuses paths outside analysis/ and calibration/', async () => {
		const res = await appFetch('/api/agent/research/protocols', { headers: agentHeaders });
		expect(res.status).toBe(404);
		const data = await res.json();
		expect(data.success).toBe(false);
	});

	it('proxies the analysis catalog or reports missing configuration', async () => {
		const res = await appFetch('/api/agent/research/analysis/catalog', { headers: agentHeaders });
		expect([200, 502, 503]).toContain(res.status);
		const data = await res.json();
		if (res.status === 200) {
			expect(data.success).toBe(true);
			expect(data.data.reducers).toContain('mean');
		} else {
			expect(data.success).toBe(false);
			expect(typeof data.error).toBe('string');
		}
	});
});
