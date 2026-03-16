import { describe, it, expect } from 'vitest';
import { getPageData } from '../helpers/client';

describe('Documents', () => {
  it('GET /documents returns document list', async () => {
    const { status, pageKeys } = await getPageData('/documents');
    expect(status).toBe(200);
    expect(pageKeys).toContain('documents');
  });

  it('GET /documents/approvals returns approvals page', async () => {
    const { status } = await getPageData('/documents/approvals');
    expect(status).toBe(200);
  });

  it('GET /documents/training returns training page', async () => {
    const { status } = await getPageData('/documents/training');
    expect(status).toBe(200);
  });

  it('GET /documents/new returns new document form', async () => {
    const { status } = await getPageData('/documents/new');
    expect(status).toBe(200);
  });

  it('GET /spu/documents returns SPU documents page', async () => {
    const { status } = await getPageData('/spu/documents');
    expect(status).toBe(200);
  });

  it('GET /spu/documents/instructions returns work instructions', async () => {
    const { status, pageKeys } = await getPageData('/spu/documents/instructions');
    expect(status).toBe(200);
    expect(pageKeys).toContain('workInstructions');
  });

  it('GET /spu/documents/repository returns repository', async () => {
    const { status, pageKeys } = await getPageData('/spu/documents/repository');
    expect(status).toBe(200);
  });

  it('GET /spu/documents/build-logs returns build logs', async () => {
    const { status } = await getPageData('/spu/documents/build-logs');
    expect(status).toBe(200);
  });
});
