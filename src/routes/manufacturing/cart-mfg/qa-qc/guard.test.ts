import { beforeEach, describe, expect, it, vi } from 'vitest';

// QA/QC actions against an in-memory cartridge collection: a cart a customer has
// linked is never released, voided or scrapped, and gets no transaction or
// audit row; the other carts proceed.
const state = vi.hoisted(() => ({
	model: null as any,
	run: null as any,
	runUpdates: [] as any[],
	audit: [] as any[],
	tx: [] as any[]
}));

vi.mock('$lib/server/db', async () => {
	const { fakeCartridgeModel } = await import('$lib/server/manufacturing/testkit/fake-cartridges');
	const docs = new Map<string, any>();
	state.model = Object.assign(fakeCartridgeModel(docs), { docs });
	return {
		connectDB: async () => {},
		CartridgeRecord: state.model,
		ReagentBatchRecord: {
			findById: () => ({ lean: async () => structuredClone(state.run) }),
			findByIdAndUpdate: async (id: string, update: any) => state.runUpdates.push({ id, update })
		},
		User: {},
		AuditLog: { create: async (row: any) => state.audit.push(row) },
		generateId: () => 'gen'
	};
});
vi.mock('$lib/server/permissions', () => ({ requirePermission: () => {} }));
vi.mock('$lib/server/services/inventory-transaction', () => ({
	recordTransaction: async (row: any) => state.tx.push(row)
}));

import { actions } from './+page.server';
import { customerLinked, researchLinked } from '$lib/server/manufacturing/testkit/fake-cartridges';

const locals = { user: { _id: 'u1', username: 'qa' } } as any;
function post(action: string, fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return new Request(`http://bims.test/manufacturing/cart-mfg/qa-qc?/${action}`, { method: 'POST', body: fd });
}

beforeEach(() => {
	state.model.docs.clear();
	state.runUpdates = [];
	state.audit = [];
	state.tx = [];
	state.run = null;
	for (const d of [
		{ _id: 'A', status: 'reagent_filled' },
		{ _id: 'B', status: 'reagent_filled' },
		customerLinked('HELD'),
		researchLinked('R')
	]) state.model.docs.set(d._id, d);
});

describe('qa-qc startTesting', () => {
	it('releases the others, leaves the customer-linked cart out of the sample list, and says so', async () => {
		const res: any = await actions.startTesting({
			request: post('startTesting', { releaseId: 'RUN1', cartridgeIds: JSON.stringify(['A', 'HELD', 'R']) }),
			locals
		} as any);
		expect(res.success).toBe(true);
		expect(res.warning).toBe('1 cartridge was not marked for testing because a customer has linked it: HELD');
		expect(state.model.docs.get('A').status).toBe('released');
		expect(state.model.docs.get('R').status).toBe('released'); // research links unchanged behaviour
		expect(state.model.docs.get('HELD').status).toBe('linked');
		expect(state.runUpdates[0].update.$set['qcRelease.qaqcCartridgeIds']).toEqual(['A', 'R']);
	});
});

describe('qa-qc recordResult', () => {
	it('pass: releases the samples except the customer-linked one; transactions only for the written carts', async () => {
		state.run = { _id: 'RUN1', qcRelease: { qaqcCartridgeIds: ['A', 'HELD', 'B'], shippingLotId: 'SL1' } };
		const res: any = await actions.recordResult({ request: post('recordResult', { releaseId: 'RUN1', result: 'passed' }), locals } as any);
		expect(res.success).toBe(true);
		expect(res.warning).toBe('1 cartridge was not released because a customer has linked it: HELD');
		expect(state.model.docs.get('A').status).toBe('released');
		expect(state.model.docs.get('B').status).toBe('released');
		const held = state.model.docs.get('HELD');
		expect(held.status).toBe('linked');
		expect(held.qaqcRelease).toBeUndefined();
		expect(state.tx.map((t) => t.cartridgeRecordId)).toEqual(['A', 'B']);
	});

	it('fail: voids the others, never the customer-linked one', async () => {
		state.run = { _id: 'RUN1', qcRelease: { qaqcCartridgeIds: ['HELD', 'A'], shippingLotId: 'SL1' } };
		const res: any = await actions.recordResult({ request: post('recordResult', { releaseId: 'RUN1', result: 'failed' }), locals } as any);
		expect(res.warning).toBe('1 cartridge was not voided because a customer has linked it: HELD');
		expect(state.model.docs.get('A').status).toBe('voided');
		expect(state.model.docs.get('HELD').status).toBe('linked');
		expect(state.tx.map((t) => t.cartridgeRecordId)).toEqual(['A']);
	});
});

describe('qa-qc scrapCartridge', () => {
	it('refuses a customer-linked cart: no status change, no transaction, no audit row', async () => {
		const res: any = await actions.scrapCartridge({
			request: post('scrapCartridge', { cartridgeId: 'HELD', scrapCategory: 'other' }),
			locals
		} as any);
		expect(res.status).toBe(409);
		expect(res.data.error).toBe('1 cartridge was not scrapped because a customer has linked it: HELD');
		expect(state.model.docs.get('HELD').status).toBe('linked');
		expect(state.tx).toEqual([]);
		expect(state.audit).toEqual([]);
	});

	it('still scraps an ordinary cart', async () => {
		const res: any = await actions.scrapCartridge({
			request: post('scrapCartridge', { cartridgeId: 'A', scrapCategory: 'other' }),
			locals
		} as any);
		expect(res).toEqual({ success: true });
		expect(state.model.docs.get('A').status).toBe('scrapped');
		expect(state.audit.map((r) => r.recordId)).toEqual(['A']);
	});
});
