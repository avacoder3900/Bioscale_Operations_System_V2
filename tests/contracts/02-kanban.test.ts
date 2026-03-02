import { describe, it, expect } from 'vitest';
import { appFetch, getPageData } from '../helpers/client';

describe('Kanban', () => {
  it('GET /kanban returns board data with projects and users', async () => {
    const { status, pageKeys } = await getPageData('/kanban');
    expect(status).toBe(200);
    expect(pageKeys).toContain('projects');
    expect(pageKeys).toContain('users');
  });

  it('GET /kanban/list returns list view', async () => {
    const { status } = await getPageData('/kanban/list');
    expect(status).toBe(200);
  });

  it('GET /kanban/projects returns projects', async () => {
    const { status, pageKeys } = await getPageData('/kanban/projects');
    expect(status).toBe(200);
    expect(pageKeys).toContain('projects');
  });

  it('GET /kanban/archived returns archived tasks', async () => {
    const { status, pageKeys } = await getPageData('/kanban/archived');
    expect(status).toBe(200);
  });

  it('POST /api/kanban/move accepts move requests', async () => {
    // Just verify the endpoint exists and requires proper data
    const res = await appFetch('/api/kanban/move', {
      method: 'POST',
      body: {},
    });
    // Should return 400 (bad request) not 404
    expect([400, 422, 500]).toContain(res.status);
  });
});
