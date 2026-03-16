import { describe, it, expect } from 'vitest';
import { getPageData } from '../helpers/client';

describe('Shipping', () => {
  it('GET /spu/shipping returns shipping page', async () => {
    const { status, pageKeys } = await getPageData('/spu/shipping');
    expect(status).toBe(200);
  });
});
