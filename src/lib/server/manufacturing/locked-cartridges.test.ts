import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ model: null as any }));

vi.mock('$lib/server/db', async () => {
	const { fakeCartridgeModel } = await import('./testkit/fake-cartridges');
	const docs = new Map<string, any>();
	state.model = Object.assign(fakeCartridgeModel(docs), { docs });
	return { CartridgeRecord: state.model, AuditLog: { insertMany: vi.fn() }, generateId: () => 'id' };
});

import { findCustomerHeldIds, updateEachUnlessCustomerHeld } from './locked-cartridges';
import { customerLinked, researchLinked } from './testkit/fake-cartridges';

beforeEach(() => {
	state.model.docs.clear();
	state.model.writes.length = 0;
	for (const d of [
		customerLinked('HELD'),
		researchLinked('RESEARCH'),
		{ _id: 'PLAIN', status: 'released' },
		{ _id: 'DONE', status: 'released', qaqcRelease: { recordedAt: new Date() } }
	]) state.model.docs.set(d._id, d);
});

describe('updateEachUnlessCustomerHeld', () => {
	it('writes every cart but the customer-held one, and says which is which', async () => {
		const r = await updateEachUnlessCustomerHeld(['PLAIN', 'HELD', 'RESEARCH', 'NOPE'], { $set: { status: 'stored' } });
		expect(r).toEqual({ updated: ['PLAIN', 'RESEARCH'], held: ['HELD'], notMatched: ['NOPE'] });
		expect(state.model.docs.get('HELD').status).toBe('linked');
		expect(state.model.docs.get('PLAIN').status).toBe('stored');
		// Research-arm links keep today's behaviour.
		expect(state.model.docs.get('RESEARCH').status).toBe('stored');
	});

	it('puts the guard in every write filter', async () => {
		await updateEachUnlessCustomerHeld(['PLAIN'], { $set: { status: 'stored' } });
		expect(state.model.writes[0].filter.$nor).toHaveLength(1);
		expect(state.model.writes[0].filter._id).toBe('PLAIN');
	});

	it('an extra filter that does not match is notMatched, not held', async () => {
		const r = await updateEachUnlessCustomerHeld(['DONE', 'PLAIN'], { $set: { status: 'released' } }, { 'qaqcRelease.recordedAt': { $exists: false } });
		expect(r).toEqual({ updated: ['PLAIN'], held: [], notMatched: ['DONE'] });
	});
});

describe('findCustomerHeldIds', () => {
	it('returns the held ids in the order given', async () => {
		state.model.docs.set('HELD2', customerLinked('HELD2', { status: 'completed' }));
		expect(await findCustomerHeldIds(['HELD2', 'PLAIN', 'HELD', 'RESEARCH'])).toEqual(['HELD2', 'HELD']);
		expect(await findCustomerHeldIds([])).toEqual([]);
	});
});
