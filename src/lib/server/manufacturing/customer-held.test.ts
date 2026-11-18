import { describe, expect, it } from 'vitest';
import {
	CUSTOMER_HELD_STATUSES,
	customerHeldMatch,
	customerHeldNotice,
	isCustomerHeld,
	notCustomerHeld,
	withNotCustomerHeld
} from './customer-held';
import { customerLinked, matches, researchLinked } from './testkit/fake-cartridges';

const legacyApp = { _id: 'L', status: 'underway', checkpoints: { linked: { who: 'google:123', via: 'bioscale-business' } } };
const apiOnlyWho = { _id: 'W', status: 'completed', checkpoints: { linked: { who: 'app:h_abcdefghijklmnop' } } };
const cancelled = customerLinked('C', { status: 'cancelled' });
const unlinked = { _id: 'U', status: 'released' };
const appCheckpointButBackInStock = customerLinked('S', { status: 'released' });

describe('the customer-held rule', () => {
	it('holds the four test-side statuses', () => {
		expect([...CUSTOMER_HELD_STATUSES]).toEqual(['linked', 'underway', 'completed', 'cancelled']);
	});

	it('is held: a customer-app checkpoint (via or app: who) at a test-side status', () => {
		for (const r of [customerLinked('A'), legacyApp, apiOnlyWho, cancelled]) expect(isCustomerHeld(r)).toBe(true);
	});

	it('is not held: research arm links, unlinked carts, an app checkpoint on a non test-side status', () => {
		for (const r of [researchLinked('R'), unlinked, appCheckpointButBackInStock, null, undefined]) {
			expect(isCustomerHeld(r as any)).toBe(false);
		}
	});

	it('the Mongo match agrees with the JS rule', () => {
		const docs = [customerLinked('A'), legacyApp, apiOnlyWho, cancelled, researchLinked('R'), unlinked, appCheckpointButBackInStock];
		for (const d of docs) {
			expect(matches(d, customerHeldMatch())).toBe(isCustomerHeld(d));
			expect(matches(d, notCustomerHeld())).toBe(!isCustomerHeld(d));
		}
	});

	it('withNotCustomerHeld keeps the filter and any $nor it already had', () => {
		const f = withNotCustomerHeld({ _id: 'A', $nor: [{ status: 'voided' }] });
		expect(f._id).toBe('A');
		expect(f.$nor).toHaveLength(2);
		expect(matches({ _id: 'A', status: 'voided' }, f)).toBe(false);
		expect(matches(customerLinked('A'), f)).toBe(false);
		expect(matches({ _id: 'A', status: 'released' }, f)).toBe(true);
	});
});

describe('customerHeldNotice', () => {
	it('null when nothing was skipped', () => {
		expect(customerHeldNotice('stored', [])).toBeNull();
	});
	it('names the ids, singular and plural', () => {
		expect(customerHeldNotice('stored', ['A'])).toBe('1 cartridge was not stored because a customer has linked it: A');
		expect(customerHeldNotice('shipped', ['A', 'B'])).toBe('2 cartridges were not shipped because a customer has linked them: A, B');
	});
});
