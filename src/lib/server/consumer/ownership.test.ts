import { describe, expect, it, vi } from 'vitest';

// The service module imports the Mongoose models for its DB functions; the
// pure rules under test never touch them.
vi.mock('$lib/server/db', () => ({
	AuditLog: {}, CartridgeOwnership: {}, CartridgeRecord: {}, ConsumerClaimAttempt: {},
	ConsumerInvite: {}, Customer: {}, CustomerAccount: {}, ShippingLot: {}, generateId: () => 'id'
}));

import { claimEligibility, isGuessableId, stageOf } from './ownership';

const uuid = '0b6c9c2e-7f1a-4c7e-9a7b-2d6f4f0a1b2c';
const base = { cartridge: { _id: uuid, status: 'shipped' }, hasOpenOwnership: false, isQcCartridge: false, matchedShipment: false, allowResearch: false };

describe('isGuessableId', () => {
	it('flags sequential prefixed ids and not UUIDs', () => {
		expect(isGuessableId('CART-000123')).toBe(true);
		expect(isGuessableId('PART-000001')).toBe(true);
		expect(isGuessableId(uuid)).toBe(false);
		expect(isGuessableId('abc')).toBe(false);
	});
});

describe('stageOf', () => {
	const now = new Date('2026-10-15T12:00:00Z');
	it('reads the lifecycle', () => {
		expect(stageOf({ _id: uuid, status: 'shipped' }, now)).toBe('ready');
		expect(stageOf({ _id: uuid, status: 'completed' }, now)).toBe('used');
		expect(stageOf({ _id: uuid, status: 'underway' }, now)).toBe('used');
		expect(stageOf({ _id: uuid, status: 'voided' }, now)).toBe('unavailable');
		expect(stageOf({ _id: uuid, status: 'shipped', voidedAt: new Date() }, now)).toBe('unavailable');
	});
	it('prefers the reagent expiry and treats a past date as expired', () => {
		expect(stageOf({ _id: uuid, status: 'shipped', reagentFilling: { expirationDate: '2026-01-01' } }, now)).toBe('expired');
		expect(stageOf({ _id: uuid, status: 'shipped', expirationDate: '2027-01-01' }, now)).toBe('ready');
		expect(stageOf({ _id: uuid, status: 'shipped', expirationDate: 'garbage' }, now)).toBe('ready');
	});
});

describe('claimEligibility', () => {
	it('allows an unshipped, unowned UUID cartridge (shipment match is not a gate)', () => {
		expect(claimEligibility(base)).toEqual({ ok: true });
	});
	it('refuses what cannot be claimed, in priority order', () => {
		expect(claimEligibility({ ...base, cartridge: null })).toEqual({ ok: false, reason: 'not_found' });
		expect(claimEligibility({ ...base, cartridge: { _id: uuid, status: 'scrapped' } })).toEqual({ ok: false, reason: 'voided' });
		expect(claimEligibility({ ...base, isQcCartridge: true })).toEqual({ ok: false, reason: 'qc_cartridge' });
		expect(claimEligibility({ ...base, cartridge: { _id: uuid, usedForTestFill: true } })).toEqual({ ok: false, reason: 'qc_cartridge' });
		expect(claimEligibility({ ...base, cartridge: { _id: uuid, experiment: 'EXP-1' } })).toEqual({ ok: false, reason: 'research' });
		expect(claimEligibility({ ...base, hasOpenOwnership: true })).toEqual({ ok: false, reason: 'already_owned' });
	});
	it('lets an internal customer claim research cartridges', () => {
		expect(claimEligibility({ ...base, cartridge: { _id: uuid, experiment: 'EXP-1' }, allowResearch: true })).toEqual({ ok: true });
	});
	it('requires a shipment match only for guessable ids', () => {
		const seq = { ...base, cartridge: { _id: 'CART-000123', status: 'shipped' } };
		expect(claimEligibility(seq)).toEqual({ ok: false, reason: 'guessable_id_needs_match' });
		expect(claimEligibility({ ...seq, matchedShipment: true })).toEqual({ ok: true });
	});
	it('allows a cartridge that has already run — its results become visible on claim', () => {
		expect(claimEligibility({ ...base, cartridge: { _id: uuid, status: 'completed' } })).toEqual({ ok: true });
	});
});
