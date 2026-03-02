import { describe, it, expect } from 'vitest';
import { getPageData } from '../helpers/client';

describe('Manufacturing', () => {
  it('GET /spu/manufacturing returns manufacturing dashboard', async () => {
    const { status, pageKeys } = await getPageData('/spu/manufacturing');
    expect(status).toBe(200);
    expect(pageKeys).toContain('recentLots');
  });

  it('GET /spu/manufacturing/wax-filling returns wax filling page', async () => {
    const { status } = await getPageData('/spu/manufacturing/wax-filling');
    expect(status).toBe(200);
  });

  it('GET /spu/manufacturing/wax-filling/equipment returns equipment page', async () => {
    const { status } = await getPageData('/spu/manufacturing/wax-filling/equipment');
    expect(status).toBe(200);
  });

  it('GET /spu/manufacturing/wax-filling/oven-queue returns oven queue', async () => {
    const { status } = await getPageData('/spu/manufacturing/wax-filling/oven-queue');
    expect(status).toBe(200);
  });

  it('GET /spu/manufacturing/wax-filling/settings returns settings', async () => {
    const { status } = await getPageData('/spu/manufacturing/wax-filling/settings');
    expect(status).toBe(200);
  });

  it('GET /spu/manufacturing/reagent-filling returns reagent filling', async () => {
    const { status } = await getPageData('/spu/manufacturing/reagent-filling');
    expect(status).toBe(200);
  });

  it('GET /spu/manufacturing/reagent-filling/cooling-queue returns cooling queue', async () => {
    const { status } = await getPageData('/spu/manufacturing/reagent-filling/cooling-queue');
    expect(status).toBe(200);
  });

  it('GET /spu/manufacturing/reagent-filling/settings returns settings', async () => {
    const { status } = await getPageData('/spu/manufacturing/reagent-filling/settings');
    expect(status).toBe(200);
  });

  it('GET /spu/manufacturing/qa-qc returns QA/QC page', async () => {
    const { status } = await getPageData('/spu/manufacturing/qa-qc');
    expect(status).toBe(200);
  });

  it('GET /spu/manufacturing/inventory returns manufacturing inventory', async () => {
    const { status } = await getPageData('/spu/manufacturing/inventory');
    expect(status).toBe(200);
  });

  it('GET /spu/manufacturing/laser-cutting returns laser cutting', async () => {
    const { status } = await getPageData('/spu/manufacturing/laser-cutting');
    expect(status).toBe(200);
  });

  it('GET /spu/manufacturing/top-seal-cutting returns top seal cutting', async () => {
    const { status } = await getPageData('/spu/manufacturing/top-seal-cutting');
    expect(status).toBe(200);
  });
});
