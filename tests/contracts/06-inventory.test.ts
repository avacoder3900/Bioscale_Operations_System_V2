import { describe, it, expect } from 'vitest';
import { appFetch, getPageData } from '../helpers/client';

describe('Inventory & Parts', () => {
  it('GET /spu/parts returns parts list', async () => {
    const { status, pageKeys } = await getPageData('/spu/parts');
    expect(status).toBe(200);
    expect(pageKeys).toContain('items');
  });

  it('GET /spu/bom returns BOM page', async () => {
    const { status, pageKeys } = await getPageData('/spu/bom');
    expect(status).toBe(200);
  });

  it('GET /spu/bom/folders returns BOM folders', async () => {
    const { status } = await getPageData('/spu/bom/folders');
    expect(status).toBe(200);
  });

  it('GET /spu/bom/settings returns BOM settings', async () => {
    const { status } = await getPageData('/spu/bom/settings');
    expect(status).toBe(200);
  });

  it('GET /spu/inventory/transactions returns transactions', async () => {
    const { status, pageKeys } = await getPageData('/spu/inventory/transactions');
    expect(status).toBe(200);
    expect(pageKeys).toContain('transactions');
  });

  it('GET /api/inventory/transactions returns JSON', async () => {
    const res = await appFetch('/api/inventory/transactions');
    expect([200, 400]).toContain(res.status);
  });

  it('GET /api/bom/search accepts search query', async () => {
    const res = await appFetch('/api/bom/search?q=test');
    expect([200, 400]).toContain(res.status);
  });
});
