import { describe, it, expect } from 'vitest';
import { getPageData } from '../helpers/client';

describe('Cartridges', () => {
  it('GET /spu/cartridges returns cartridge list', async () => {
    const { status, pageKeys } = await getPageData('/spu/cartridges');
    expect(status).toBe(200);
    expect(pageKeys).toContain('cartridges');
  });

  it('GET /spu/cartridges/groups returns cartridge groups', async () => {
    const { status } = await getPageData('/spu/cartridges/groups');
    expect(status).toBe(200);
  });

  it('GET /spu/cartridges/analysis returns analysis page', async () => {
    const { status } = await getPageData('/spu/cartridges/analysis');
    expect(status).toBe(200);
  });

  it('GET /spu/cartridge-dashboard returns dashboard', async () => {
    const { status } = await getPageData('/spu/cartridge-dashboard');
    expect(status).toBe(200);
  });

  it('GET /spu/cartridge-admin returns admin page', async () => {
    const { status } = await getPageData('/spu/cartridge-admin');
    expect(status).toBe(200);
  });

  it('GET /spu/cartridge-admin/filled returns filled cartridges', async () => {
    const { status } = await getPageData('/spu/cartridge-admin/filled');
    expect(status).toBe(200);
  });

  it('GET /spu/cartridge-admin/statistics returns statistics', async () => {
    const { status } = await getPageData('/spu/cartridge-admin/statistics');
    expect(status).toBe(200);
  });

  it('GET /spu/cartridge-admin/storage returns storage', async () => {
    const { status } = await getPageData('/spu/cartridge-admin/storage');
    expect(status).toBe(200);
  });

  it('GET /spu/cartridge-admin/failures returns failures', async () => {
    const { status } = await getPageData('/spu/cartridge-admin/failures');
    expect(status).toBe(200);
  });

  it('GET /spu/cartridge-admin/release returns release page', async () => {
    const { status } = await getPageData('/spu/cartridge-admin/release');
    expect(status).toBe(200);
  });

  it('GET /spu/cartridge-admin/sku-management returns SKU management', async () => {
    const { status } = await getPageData('/spu/cartridge-admin/sku-management');
    expect(status).toBe(200);
  });
});
