import { describe, it, expect } from 'vitest';
import { appFetch } from '../helpers/client';

const API_KEY = process.env.AGENT_API_KEY || 'bvt_ak_7mXpL9wQzR3nKfY2dHsJ6vTcA8eUgB4x';
const agentHeaders = { 'X-API-Key': API_KEY };

describe('Agent API', () => {
  it('GET /api/agent/health returns health status', async () => {
    const res = await appFetch('/api/agent/health');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('success', true);
    expect(data.data).toHaveProperty('status');
  });

  it('GET /api/agent/schema returns schema info', async () => {
    const res = await appFetch('/api/agent/schema', { headers: agentHeaders });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('success', true);
  });

  it('GET /api/agent/system returns system info', async () => {
    const res = await appFetch('/api/agent/system', { headers: agentHeaders });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('success', true);
  });

  it('GET /api/agent/messages requires userId param', async () => {
    const res = await appFetch('/api/agent/messages', { headers: agentHeaders });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data).toHaveProperty('success', false);
  });

  it('GET /api/agent/messages with userId returns messages', async () => {
    const res = await appFetch('/api/agent/messages?userId=test-contract-runner', { headers: agentHeaders });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('success');
  });

  it('GET /api/agent/operations/dashboard returns dashboard', async () => {
    const res = await appFetch('/api/agent/operations/dashboard', { headers: agentHeaders });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('success', true);
  });

  it('GET /api/agent/operations/context returns context', async () => {
    const res = await appFetch('/api/agent/operations/context', { headers: agentHeaders });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('success', true);
  });

  it('GET /api/agent/operations/kanban/board-snapshot returns board', async () => {
    const res = await appFetch('/api/agent/operations/kanban/board-snapshot', { headers: agentHeaders });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('success', true);
  });

  it('GET /api/agent/operations/equipment returns equipment', async () => {
    const res = await appFetch('/api/agent/operations/equipment', { headers: agentHeaders });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('success', true);
  });

  it('GET /api/agent/operations/inventory returns inventory', async () => {
    const res = await appFetch('/api/agent/operations/inventory', { headers: agentHeaders });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('success', true);
  });

  it('GET /api/agent/operations/projects returns projects', async () => {
    const res = await appFetch('/api/agent/operations/projects', { headers: agentHeaders });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('success', true);
  });

  it('GET /api/agent/operations/documents returns documents', async () => {
    const res = await appFetch('/api/agent/operations/documents', { headers: agentHeaders });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('success', true);
  });

  it('GET /api/agent/operations/alerts returns alerts', async () => {
    const res = await appFetch('/api/agent/operations/alerts', { headers: agentHeaders });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('success', true);
  });

  it('GET /api/agent/operations/quality/trends returns quality trends', async () => {
    const res = await appFetch('/api/agent/operations/quality/trends', { headers: agentHeaders });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('success', true);
  });

  it('GET /api/agent/query requires API key', async () => {
    const res = await appFetch('/api/agent/query');
    // Without API key, should fail
    expect([401, 500]).toContain(res.status);
  });

  it('POST /api/agent/query/seed with API key returns response', async () => {
    const res = await appFetch('/api/agent/query/seed', { method: 'POST', headers: agentHeaders });
    expect([200, 400, 405]).toContain(res.status);
  });
});
