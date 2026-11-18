import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Store action against an in-memory cartridge collection: a cart a customer
// has linked is never stored and gets no inventory or audit row.
const state = vi.hoisted(() => ({ model: null as any, audit: [] as any[], tx: [] as any[] }));

vi.mock('$lib/server/db', async () => {
	const { fakeCartridgeModel } = await import('$lib/server/manufacturing/testkit/fake-cartridges');
	const docs = new Map<string, any>();
	state.model = Object.assign(fakeCartridgeModel(docs), { docs });
	return {
		connectDB: async () => {},
		CartridgeRecord: state.model,
		Equipment: {},
		EquipmentLocation: {},
		AuditLog: { create: async (row: any) => state.audit.push(row) },
		generateId: () => 'gen'
	};
});
vi.mock('$lib/server/permissions', () => ({ requirePermission: () => {} }));
vi.mock('$lib/server/services/inventory-transaction', () => ({
	recordTransaction: async (row: any) => state.tx.push(row)
}));
vi.mock('$lib/server/services/equipment-resolve', () => ({ resolveFridgeId: async () => null }));

import { actions } from './+page.server';
import { customerLinked, researchLinked } from '$lib/server/manufacturing/testkit/fake-cartridges';

const locals = { user: { _id: 'u1', username: 'op' } } as any;
function post(fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return new Request('http://bims.test/cartridge-admin/storage?/store', { method: 'POST', body: fd });
}

beforeEach(() => {
	state.model.docs.clear();
	state.audit = [];
	state.tx = [];
	for (const d of [{ _id: 'A', status: 'released' }, customerLinked('HELD'), researchLinked('R', { status: 'released' })]) {
		state.model.docs.set(d._id, d);
	}
});

describe('storage store', () => {
	it('stores the others, skips and reports the customer-linked cart, no audit or inventory row for it', async () => {
		const res: any = await actions.store({ request: post({ cartridgeIds: 'A,HELD,R', fridgeId: 'FRIDGE-1' }), locals } as any);
		expect(res.success).toBe(true);
		expect(res.message).toBe('2 cartridges stored in FRIDGE-1');
		expect(res.warning).toBe('1 cartridge was not stored because a customer has linked it: HELD');

		expect(state.model.docs.get('A').status).toBe('stored');
		expect(state.model.docs.get('R').status).toBe('stored');
		const held = state.model.docs.get('HELD');
		expect(held.status).toBe('linked');
		expect(held.storage).toBeUndefined();

		expect(state.audit.map((r) => r.recordId).sort()).toEqual(['A', 'R']);
		expect(state.tx.map((r) => r.cartridgeRecordId).sort()).toEqual(['A', 'R']);
	});

	it('only customer-linked carts selected: refused, nothing written', async () => {
		const res: any = await actions.store({ request: post({ cartridgeIds: 'HELD', fridgeId: 'FRIDGE-1' }), locals } as any);
		expect(res.status).toBe(409);
		expect(res.data.error).toBe('1 cartridge was not stored because a customer has linked it: HELD');
		expect(state.audit).toEqual([]);
		expect(state.tx).toEqual([]);
	});
});
