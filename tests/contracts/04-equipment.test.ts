import { describe, it, expect } from 'vitest';
import { getPageData } from '../helpers/client';

describe('Equipment', () => {
  it('GET /spu/equipment/fridges-ovens returns locations and sensors', async () => {
    const { status, pageKeys } = await getPageData('/spu/equipment/fridges-ovens');
    expect(status).toBe(200);
    expect(pageKeys).toContain('locations');
    expect(pageKeys).toContain('equipmentSensors');
    expect(pageKeys).toContain('isAdmin');
  });

  it('GET /spu/equipment/detail returns equipment detail page', async () => {
    const { status } = await getPageData('/spu/equipment/detail');
    expect(status).toBe(200);
  });

  it('GET /spu/equipment/activity returns activity page', async () => {
    const { status } = await getPageData('/spu/equipment/activity');
    expect(status).toBe(200);
  });

  it('GET /spu/equipment/decks-trays returns decks/trays', async () => {
    const { status } = await getPageData('/spu/equipment/decks-trays');
    expect(status).toBe(200);
  });

  it('GET /spu/equipment/temperature-probes returns probes', async () => {
    const { status } = await getPageData('/spu/equipment/temperature-probes');
    expect(status).toBe(200);
  });
});
