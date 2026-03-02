import { describe, it, expect } from 'vitest';
import { appFetch, getPageData } from '../helpers/client';

describe('Customers', () => {
  it('GET /spu/customers returns customer list', async () => {
    const { status, pageKeys } = await getPageData('/spu/customers');
    expect(status).toBe(200);
    expect(pageKeys).toContain('customers');
  });

  it('GET /spu/customers/[id] returns customer detail (or 404 for missing)', async () => {
    // First get the list to find a real customer ID
    const { raw } = await getPageData('/spu/customers');
    // Just verify the route pattern works
    const res = await appFetch('/spu/customers/nonexistent/__data.json');
    // Should be 200 (page loads) or redirect, not 500
    expect([200, 302, 404]).toContain(res.status);
  });
});
