import { beforeEach, describe, expect, it, vi } from 'vitest';

// claimForAccount against in-memory stand-ins for the models it touches.
const state = vi.hoisted(() => ({
	cartridge: null as any,
	open: null as any,
	qc: false,
	internal: false,
	created: [] as any[],
	released: [] as any[]
}));
const lean = (v: () => unknown) => ({ lean: async () => v(), select: () => ({ lean: async () => v() }) });

vi.mock('$lib/server/db', () => ({
	AuditLog: { create: vi.fn(async () => ({})) },
	CartridgeRecord: { findById: () => lean(() => state.cartridge) },
	CartridgeOwnership: {
		findOne: () => lean(() => state.open),
		updateOne: vi.fn(async (_q: unknown, u: any) => { state.released.push(u.$set); state.open = null; }),
		create: vi.fn(async (row: any) => {
			if (state.open) throw Object.assign(new Error('dup'), { code: 11000 });
			state.created.push(row);
		})
	},
	ShippingLot: { exists: async () => state.qc },
	Customer: { exists: async () => state.internal },
	ConsumerInvite: {}, CustomerAccount: {}, generateId: () => 'id'
}));

import { claimForAccount } from './ownership';

const uuid = '0b6c9c2e-7f1a-4c7e-9a7b-2d6f4f0a1b2c';
const input = { cartridgeId: uuid, accountId: 'google:me', accountLabel: 'me@x', customerIds: [], overwrite: false };

beforeEach(() => {
	Object.assign(state, {
		cartridge: { _id: uuid, status: 'shipped' }, open: null, qc: false, internal: false, created: [], released: []
	});
});

describe('claimForAccount', () => {
	it('links an unowned cartridge to the account', async () => {
		expect(await claimForAccount(input)).toMatchObject({ ok: true, status: 'linked' });
		expect(state.created[0]).toMatchObject({ cartridgeId: uuid, accountId: 'google:me', source: 'claim', customerId: null });
	});

	it('reports a cartridge that is already the account\'s own without writing', async () => {
		state.open = { _id: 'row1', cartridgeId: uuid, accountId: 'google:me' };
		expect(await claimForAccount(input)).toEqual({ ok: true, status: 'already_yours', rowId: 'row1' });
		expect(state.created).toHaveLength(0);
	});

	it('asks before taking a cartridge from another account, then overwrites on yes', async () => {
		state.open = { _id: 'row1', cartridgeId: uuid, accountId: 'apple:them' };
		expect(await claimForAccount(input)).toMatchObject({ ok: false, reason: 'owned_by_other' });
		expect(state.created).toHaveLength(0);

		expect(await claimForAccount({ ...input, overwrite: true })).toMatchObject({ ok: true, status: 'overwritten' });
		expect(state.released[0]).toMatchObject({ open: false, releaseReason: 'reassigned' });
		expect(state.created[0]).toMatchObject({ accountId: 'google:me' });
	});

	it('never overwrites a cartridge that has already run', async () => {
		state.cartridge = { _id: uuid, status: 'completed' };
		state.open = { _id: 'row1', cartridgeId: uuid, accountId: 'apple:them' };
		expect(await claimForAccount({ ...input, overwrite: true })).toMatchObject({ ok: false, reason: 'has_results' });
		expect(state.released).toHaveLength(0);
	});

	it('keeps the old eligibility rules', async () => {
		state.cartridge = null;
		expect(await claimForAccount(input)).toMatchObject({ ok: false, reason: 'not_found' });
		state.cartridge = { _id: uuid, status: 'voided' };
		expect(await claimForAccount(input)).toMatchObject({ ok: false, reason: 'voided' });
		state.cartridge = { _id: uuid, status: 'shipped' };
		state.qc = true;
		expect(await claimForAccount(input)).toMatchObject({ ok: false, reason: 'qc_cartridge' });
		state.qc = false;
		state.cartridge = { _id: 'CART-000123', status: 'shipped' };
		expect(await claimForAccount({ ...input, cartridgeId: 'CART-000123', overwrite: true }))
			.toMatchObject({ ok: false, reason: 'guessable_id_needs_match' });
	});
});
