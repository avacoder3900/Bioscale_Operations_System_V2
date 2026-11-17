import { describe, expect, it } from 'vitest';
import {
	HOLDER_REF,
	checkSummary,
	eligibility,
	evaluateLink,
	evaluateUnlink,
	expiryOf,
	linkedBy,
	type RuleRecord
} from './rules';
import { analyteForAssay } from './analytes';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const ME = 'h_AAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'h_BBBBBBBBBBBBBBBBBBBBBBBB';
const ready: RuleRecord = { status: 'shipped', assayId: 'A56E0F5A' };
const opts = { holderRef: ME, isQcCartridge: false, now: NOW };

describe('eligibility: every refusal', () => {
	const cases: [string, RuleRecord | null, Partial<typeof opts>, string][] = [
		['unknown code', null, {}, 'not_found'],
		['run data (rawData)', { ...ready, rawData: true }, {}, 'has_results'],
		['run data (reading)', { ...ready, reading: true }, {}, 'has_results'],
		['run data wins over status', { ...ready, status: 'completed', rawData: true }, {}, 'has_results'],
		['used flag', { ...ready, used: true }, {}, 'has_results'],
		['running on a reader', { ...ready, status: 'underway' }, {}, 'in_use'],
		['voided status', { ...ready, status: 'voided' }, {}, 'voided'],
		['scrapped status', { ...ready, status: 'scrapped' }, {}, 'voided'],
		['voidedAt set', { ...ready, voidedAt: '2026-11-01T00:00:00Z' }, {}, 'voided'],
		['completed with no run data', { ...ready, status: 'completed' }, {}, 'unavailable'],
		['cancelled', { ...ready, status: 'cancelled' }, {}, 'unavailable'],
		['QA/QC release cartridge', ready, { isQcCartridge: true }, 'qc_cartridge'],
		['test-fill cartridge', { ...ready, usedForTestFill: true }, {}, 'qc_cartridge'],
		['research experiment', { ...ready, experiment: 'EXP-12' }, {}, 'research'],
		['no assay', { status: 'shipped' }, {}, 'no_assay'],
		['blank assay', { ...ready, assayId: '  ' }, {}, 'no_assay'],
		['"Select Assay" sentinel', { ...ready, assayId: '0' }, {}, 'no_assay'],
		['past top-level expiry', { ...ready, expirationDate: '2026-11-15' }, {}, 'expired'],
		['past fill expiry', { ...ready, reagentFilling: { expirationDate: new Date('2026-01-01') } }, {}, 'expired'],
		['fill expiry wins over a later top-level one', { ...ready, expirationDate: '2030-01-01', reagentFilling: { expirationDate: '2026-01-01' } }, {}, 'expired'],
		['linked by someone else', { ...ready, status: 'linked', checkpoints: { linked: { who: `app:${OTHER}` } } }, {}, 'linked_by_other'],
		['linked by a research user', { ...ready, status: 'linked', checkpoints: { linked: { who: 'jacob' } } }, {}, 'linked_by_other'],
		['linked, caller names no holder', { ...ready, status: 'linked', checkpoints: { linked: { who: `app:${ME}` } } }, { holderRef: null as any }, 'linked_by_other']
	];
	it.each(cases)('%s', (_name, record, over, reason) => {
		expect(eligibility(record, { ...opts, ...over })).toEqual({ ok: false, reason });
	});

	it('a research cartridge is refused even when this holder linked it', () => {
		const r = { ...ready, status: 'linked', experiment: 'EXP-12', checkpoints: { linked: { who: `app:${ME}` } } };
		expect(eligibility(r, opts)).toEqual({ ok: false, reason: 'research' });
	});
});

describe('eligibility: usable', () => {
	it.each(['shipped', 'released', 'stored', 'reagent_ready'])('a %s cartridge with an assay is ready', (status) => {
		expect(eligibility({ ...ready, status }, opts)).toEqual({ ok: true, linked: false });
	});
	it('an unexpired, unparseable or absent expiry does not refuse', () => {
		expect(eligibility({ ...ready, expirationDate: '2030-01-01' }, opts).ok).toBe(true);
		expect(eligibility({ ...ready, expirationDate: 'soon' }, opts).ok).toBe(true);
		expect(eligibility({ ...ready, expirationDate: null }, opts).ok).toBe(true);
	});
	it('linked by this holder is already theirs, under either spelling of who', () => {
		for (const who of [`app:${ME}`, ME]) {
			expect(eligibility({ ...ready, status: 'linked', checkpoints: { linked: { who } } }, opts)).toEqual({ ok: true, linked: true });
		}
	});
});

describe('checkSummary', () => {
	it.each([
		[{ ok: true, linked: false }, { usable: true, reason: null, state: 'ready' }],
		[{ ok: true, linked: true }, { usable: true, reason: null, state: 'linked' }],
		[{ ok: false, reason: 'has_results' }, { usable: false, reason: 'has_results', state: 'finished' }],
		[{ ok: false, reason: 'in_use' }, { usable: false, reason: 'in_use', state: 'running' }],
		[{ ok: false, reason: 'linked_by_other' }, { usable: false, reason: 'linked_by_other', state: 'linked' }],
		[{ ok: false, reason: 'expired' }, { usable: false, reason: 'expired', state: 'unavailable' }],
		[{ ok: false, reason: 'voided' }, { usable: false, reason: 'voided', state: 'unavailable' }]
	] as const)('%o', (verdict, summary) => {
		expect(checkSummary(verdict as any)).toEqual(summary);
	});
});

describe('evaluateLink', () => {
	const link = (r: RuleRecord | null) => evaluateLink(r, { ...opts, app: 'bioscale-app' });

	it('sets exactly the four fields, with a pseudonymous checkpoint', () => {
		const d = link(ready);
		expect(d).toEqual({
			action: 'link',
			fromStatus: 'shipped',
			linkedAt: NOW.toISOString(),
			set: {
				status: 'linked',
				statusUpdatedOn: NOW.toISOString(),
				priorStatus: 'shipped',
				'checkpoints.linked': { who: `app:${ME}`, when: NOW.toISOString(), where: {}, via: 'bioscale-app' }
			}
		});
	});
	it('names the calling app in via', () => {
		const d = evaluateLink(ready, { ...opts, app: 'bioscale-business' });
		expect(d.action === 'link' && d.set['checkpoints.linked'].via).toBe('bioscale-business');
	});
	it('a record with no status links from "no status"', () => {
		const d = link({ assayId: 'A1' });
		expect(d).toMatchObject({ action: 'link', fromStatus: null, set: { priorStatus: '' } });
	});
	it('already linked by the same holder writes nothing', () => {
		expect(link({ ...ready, status: 'linked', checkpoints: { linked: { who: `app:${ME}` } } })).toEqual({ action: 'already' });
	});
	it('refuses with the eligibility reason', () => {
		expect(link(null)).toEqual({ action: 'refuse', reason: 'not_found' });
		expect(link({ ...ready, status: 'underway' })).toEqual({ action: 'refuse', reason: 'in_use' });
	});
});

describe('evaluateUnlink', () => {
	const mine = { status: 'linked', priorStatus: 'shipped', checkpoints: { linked: { who: `app:${ME}` } } };
	it.each([
		['unknown code', null, { action: 'refuse', reason: 'not_found' }],
		['linked by me', mine, { action: 'restore', restoredStatus: 'shipped', who: `app:${ME}` }],
		['linked by me, bare who', { ...mine, checkpoints: { linked: { who: ME } } }, { action: 'restore', restoredStatus: 'shipped', who: ME }],
		['linked by me, no prior status', { ...mine, priorStatus: '' }, { action: 'restore', restoredStatus: null, who: `app:${ME}` }],
		['linked by another holder', { ...mine, checkpoints: { linked: { who: `app:${OTHER}` } } }, { action: 'refuse', reason: 'linked_by_other' }],
		['linked with run data', { ...mine, rawData: true }, { action: 'refuse', reason: 'has_results' }],
		['running', { ...mine, status: 'underway' }, { action: 'refuse', reason: 'has_results' }],
		['completed', { ...mine, status: 'completed' }, { action: 'refuse', reason: 'has_results' }],
		['cancelled', { ...mine, status: 'cancelled' }, { action: 'refuse', reason: 'has_results' }],
		['not linked', { status: 'shipped' }, { action: 'not_linked' }],
		['not linked but carries run data', { status: 'shipped', reading: true }, { action: 'refuse', reason: 'has_results' }]
	] as [string, RuleRecord | null, unknown][])('%s', (_n, record, expected) => {
		expect(evaluateUnlink(record, ME)).toEqual(expected);
	});
});

describe('helpers', () => {
	it('holderRef pattern', () => {
		expect(HOLDER_REF.test(ME)).toBe(true);
		expect(HOLDER_REF.test('h_' + 'a'.repeat(64))).toBe(true);
		for (const bad of ['h_short', 'h_' + 'a'.repeat(65), 'x_AAAAAAAAAAAAAAAAAAAA', 'email:me@example.com', 'h_AAAAAAAAAAAAAAAA@b.c', ` ${ME}`, `${ME}\n`]) {
			expect(HOLDER_REF.test(bad)).toBe(false);
		}
	});
	it('expiryOf prefers the fill expiry', () => {
		expect(expiryOf({ expirationDate: '2030-01-01', reagentFilling: { expirationDate: '2027-01-31T00:00:00Z' } })?.toISOString()).toBe('2027-01-31T00:00:00.000Z');
		expect(expiryOf({ expirationDate: '2030-01-01' })?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
		expect(expiryOf({})).toBeNull();
	});
	it('linkedBy never matches without a holder', () => {
		expect(linkedBy({ checkpoints: { linked: { who: undefined } } }, null)).toBe(false);
		expect(linkedBy({}, ME)).toBe(false);
	});
	it('analyte by assay name', () => {
		expect(analyteForAssay('Cortisol - 6.1')).toMatchObject({ id: 'cortisol', reportedWells: ['A'] });
		expect(analyteForAssay('CRP - 1.0')).toBeNull();
		expect(analyteForAssay(null)).toBeNull();
	});
});
