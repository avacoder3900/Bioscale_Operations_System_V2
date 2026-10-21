import { beforeEach, describe, expect, it, vi } from 'vitest';

// findProtectedCarts against in-memory stand-ins for the four models it reads.
const state = vi.hoisted(() => ({
	carts: [] as any[],
	owners: [] as any[],
	users: [] as any[],
	customers: [] as any[]
}));
const query = (rows: () => any[]) => ({ select: () => ({ lean: async () => rows() }) });

vi.mock('$lib/server/db', () => ({
	CartridgeRecord: { find: (q: any) => query(() => state.carts.filter((c) => q._id.$in.includes(c._id))) },
	CartridgeOwnership: { find: (q: any) => query(() => state.owners.filter((o) => o.open && q.cartridgeId.$in.includes(o.cartridgeId))) },
	AppUser: { find: (q: any) => query(() => state.users.filter((u) => q._id.$in.includes(u._id))) },
	Customer: { find: (q: any) => query(() => state.customers.filter((c) => q._id.$in.includes(c._id))) }
}));

import { findProtectedCarts, protectedSummary } from './protected-carts';

beforeEach(() => {
	state.carts = [];
	state.owners = [];
	state.users = [];
	state.customers = [];
});

describe('findProtectedCarts', () => {
	it('returns nothing for plain manufacturing carts and unknown barcodes', async () => {
		state.carts = [{ _id: 'a', status: 'wax_filled' }, { _id: 'b', status: 'reagent_filled', experiment: '' }];
		expect(await findProtectedCarts(['a', 'b', 'nope'])).toEqual([]);
	});

	it('flags a cart linked to an experiment, naming the experiment and arm', async () => {
		state.carts = [{ _id: 'a', status: 'linked', experiment: '374 - Carts for Chris', arm: 'Carts for testing' }];
		const [p] = await findProtectedCarts(['a']);
		expect(p.barcode).toBe('a');
		expect(p.experiment).toBe('374 - Carts for Chris');
		expect(p.reasons).toEqual([
			'linked to experiment "374 - Carts for Chris" (arm "Carts for testing")',
			'status is linked — the device side owns it now'
		]);
	});

	it('flags test-side statuses even with no experiment', async () => {
		state.carts = [{ _id: 'u', status: 'underway' }, { _id: 'c', status: 'completed' }, { _id: 'r', status: 'released' }];
		const out = await findProtectedCarts(['r', 'u', 'c']);
		expect(out.map((p) => p.barcode)).toEqual(['u', 'c']);
	});

	it('flags an app-owned cart and resolves the account name', async () => {
		state.carts = [{ _id: 'a', status: 'reagent_filled' }];
		state.owners = [{ cartridgeId: 'a', accountId: 'google:1', customerId: null, open: true }];
		state.users = [{ _id: 'google:1', name: 'Chris', signInEmail: 'chris@example.com' }];
		const [p] = await findProtectedCarts(['a']);
		expect(p.owner).toEqual({ accountId: 'google:1', accountLabel: 'Chris', customerId: null, customerName: null });
		expect(p.reasons).toEqual(['owned by app account Chris']);
	});

	it('falls back to the sign-in email, then the id, for the account label', async () => {
		state.carts = [{ _id: 'a', status: 'stored' }, { _id: 'b', status: 'stored' }];
		state.owners = [
			{ cartridgeId: 'a', accountId: 'google:1', open: true },
			{ cartridgeId: 'b', accountId: 'apple:2', open: true }
		];
		state.users = [{ _id: 'google:1', signInEmail: 'chris@example.com' }];
		const out = await findProtectedCarts(['a', 'b']);
		expect(out[0].reasons).toEqual(['owned by app account chris@example.com']);
		expect(out[1].reasons).toEqual(['owned by app account apple:2']);
	});

	it('describes a clinic row with no account by customer name', async () => {
		state.carts = [{ _id: 'a', status: 'shipped' }];
		state.owners = [{ cartridgeId: 'a', accountId: null, customerId: 'cust1', open: true }];
		state.customers = [{ _id: 'cust1', name: 'Fannin Clinic' }];
		const [p] = await findProtectedCarts(['a']);
		expect(p.reasons).toEqual(['owned by customer Fannin Clinic (not yet assigned to a patient)']);
	});

	it('ignores released ownership rows', async () => {
		state.carts = [{ _id: 'a', status: 'stored' }];
		state.owners = [{ cartridgeId: 'a', accountId: 'google:1', open: false }];
		expect(await findProtectedCarts(['a'])).toEqual([]);
	});

	it('keeps the scanned order', async () => {
		state.carts = [{ _id: 'x', status: 'linked' }, { _id: 'y', status: 'linked' }, { _id: 'z', status: 'linked' }];
		const out = await findProtectedCarts(['z', 'x', 'y']);
		expect(out.map((p) => p.barcode)).toEqual(['z', 'x', 'y']);
	});
});

describe('protectedSummary', () => {
	it('is the compact audit form', async () => {
		state.carts = [{ _id: 'a', status: 'linked', experiment: 'E', arm: 'A' }];
		state.owners = [{ cartridgeId: 'a', accountId: 'google:1', customerId: null, open: true }];
		const [p] = await findProtectedCarts(['a']);
		expect(protectedSummary(p)).toEqual({ status: 'linked', experiment: 'E', arm: 'A', accountId: 'google:1', customerId: null });
	});
});
