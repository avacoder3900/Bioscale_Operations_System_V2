import { beforeEach, describe, expect, it, vi } from 'vitest';

// addCartridgeToPackage against an in-memory cartridge collection: a cart a
// customer has linked is never moved to shipped, never put in the package, and
// gets no audit or ownership row.
const state = vi.hoisted(() => ({
	model: null as any,
	audit: [] as any[],
	packagePushes: [] as any[],
	ownership: [] as any[]
}));

vi.mock('$lib/server/db', async () => {
	const { fakeCartridgeModel } = await import('$lib/server/manufacturing/testkit/fake-cartridges');
	const docs = new Map<string, any>();
	state.model = Object.assign(fakeCartridgeModel(docs), { docs });
	const pkg = { _id: 'PKG1', barcode: 'PKG-0001', customer: { _id: 'cust1', name: 'Clinic' } };
	return {
		connectDB: async () => {},
		CartridgeRecord: state.model,
		ShippingLot: {},
		Customer: {},
		ShippingPackage: {
			findById: () => ({ lean: async () => pkg }),
			findByIdAndUpdate: async (id: string, update: any) => state.packagePushes.push({ id, update })
		},
		AuditLog: { create: async (row: any) => state.audit.push(row) },
		generateId: () => 'gen'
	};
});
vi.mock('$lib/server/permissions', () => ({ requirePermission: () => {} }));
vi.mock('$lib/server/consumer/ownership', () => ({
	ownershipForShipment: async (ids: string[]) => state.ownership.push(...ids)
}));

import { actions } from './+page.server';
import { customerLinked } from '$lib/server/manufacturing/testkit/fake-cartridges';

const locals = { user: { _id: 'u1', username: 'op' } } as any;
function post(cartridgeId: string) {
	const fd = new FormData();
	fd.set('packageId', 'PKG1');
	fd.set('cartridgeId', cartridgeId);
	return new Request('http://bims.test/shipping?/addCartridgeToPackage', { method: 'POST', body: fd });
}

beforeEach(() => {
	state.model.docs.clear();
	state.audit = [];
	state.packagePushes = [];
	state.ownership = [];
	state.model.docs.set('A', { _id: 'A', status: 'stored' });
	state.model.docs.set('HELD', customerLinked('HELD'));
});

describe('shipping addCartridgeToPackage', () => {
	it('ships an ordinary cart: status, package row, audit, ownership', async () => {
		const res: any = await actions.addCartridgeToPackage({ request: post('A'), locals } as any);
		expect(res).toEqual({ success: true });
		expect(state.model.docs.get('A').status).toBe('shipped');
		expect(state.packagePushes).toHaveLength(1);
		expect(state.audit.map((r) => r.recordId)).toEqual(['A']);
		expect(state.ownership).toEqual(['A']);
	});

	it('refuses a customer-linked cart and writes nothing for it', async () => {
		const res: any = await actions.addCartridgeToPackage({ request: post('HELD'), locals } as any);
		expect(res.status).toBe(409);
		expect(res.data.error).toBe('1 cartridge was not shipped because a customer has linked it: HELD');
		const held = state.model.docs.get('HELD');
		expect(held.status).toBe('linked');
		expect(held.shipping).toBeUndefined();
		expect(state.packagePushes).toEqual([]);
		expect(state.audit).toEqual([]);
		expect(state.ownership).toEqual([]);
	});
});
