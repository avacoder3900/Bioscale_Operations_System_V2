import { describe, it, expect } from 'vitest';
import { getPageData } from '../helpers/client';

describe('SPU', () => {
  it('GET /spu returns SPU dashboard', async () => {
    const { status, pageKeys } = await getPageData('/spu');
    expect(status).toBe(200);
    expect(pageKeys).toContain('spus');
  });

  it('GET /spu/assembly returns assembly page', async () => {
    const { status, pageKeys } = await getPageData('/spu/assembly');
    expect(status).toBe(200);
  });

  it('GET /spu/assembly/complete returns completed assemblies', async () => {
    const { status } = await getPageData('/spu/assembly/complete');
    expect(status).toBe(200);
  });

  it('GET /spu/batches returns batches list', async () => {
    const { status, pageKeys } = await getPageData('/spu/batches');
    expect(status).toBe(200);
    expect(pageKeys).toContain('batches');
  });

  it('GET /spu/validation returns validation page', async () => {
    const { status } = await getPageData('/spu/validation');
    expect(status).toBe(200);
  });

  it('GET /spu/assays returns assays page', async () => {
    const { status, pageKeys } = await getPageData('/spu/assays');
    expect(status).toBe(200);
  });

  it('GET /spu/devices returns devices page', async () => {
    const { status, pageKeys } = await getPageData('/spu/devices');
    expect(status).toBe(200);
  });

  it('GET /spu/test-results returns test results', async () => {
    const { status } = await getPageData('/spu/test-results');
    expect(status).toBe(200);
  });
});
