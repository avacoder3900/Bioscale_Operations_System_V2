import { describe, expect, it } from 'vitest';
import { appMessage, codeValues, evaluatePair, evaluateUnpair, heldBy, isPairable, pickReader, type ReaderDoc } from './reader-rules';

const ME = 'h_AAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'h_BBBBBBBBBBBBBBBBBBBBBBBB';
const LABEL = '0c42168a-d868-401a-ac94-1b990f4ad10d';

const roster: ReaderDoc[] = [
	{ _id: 's230', udi: 'BT-M01-0000-0230', barcode: LABEL, status: 'released', particleLink: { particleDeviceId: 'dev230', particleSerial: 'P2MABA1234ABCD' } },
	{ _id: 's243', udi: 'BT-M01-0000-0243', barcode: null, status: 'released', particleLink: { particleDeviceId: 'dev243', particleSerial: 'P2MABA9999ZZZZ' } }
];

const resolve = (code: unknown) => {
	const values = codeValues(code);
	return values ? pickReader(roster, values)?._id ?? null : 'invalid';
};

describe('codeValues + pickReader: every accepted code form', () => {
	it('the UDI, any case, with whitespace', () => {
		expect(resolve('BT-M01-0000-0230')).toBe('s230');
		expect(resolve('  bt-m01-0000-0230\n')).toBe('s230');
	});
	it('the QR label UUID, any case', () => {
		expect(resolve(LABEL)).toBe('s230');
		expect(resolve(LABEL.toUpperCase())).toBe('s230');
	});
	it('the Particle serial, any case', () => {
		expect(resolve('P2MABA9999ZZZZ')).toBe('s243');
		expect(resolve('p2maba9999zzzz')).toBe('s243');
	});
	it('a URL carrying the UDI or the label in its path, query or hash', () => {
		expect(resolve('https://bioscale.app/r/BT-M01-0000-0230')).toBe('s230');
		expect(resolve(`https://bioscale.app/pair?code=${LABEL}`)).toBe('s230');
		expect(resolve('https://bioscale.app/pair#P2MABA9999ZZZZ')).toBe('s243');
		expect(resolve('https://bioscale.app/pair?serial=P2MABA9999ZZZZ&x=1')).toBe('s243');
	});
	it('text with a UDI or UUID inside it', () => {
		expect(resolve('Reader BT-M01-0000-0243 (Bioscale)')).toBe('s243');
		expect(resolve(`label:${LABEL};v=1`)).toBe('s230');
	});
	it('unknown codes name no reader', () => {
		expect(resolve('BT-M01-0000-9999')).toBeNull();
		expect(resolve('https://example.com/nothing')).toBeNull();
		expect(resolve('s230')).toBeNull(); // the database id is not accepted
		expect(resolve('dev230')).toBeNull(); // nor the Particle device id
	});
	it('empty, non-string and over 200 characters are invalid', () => {
		expect(resolve('')).toBe('invalid');
		expect(resolve('   ')).toBe('invalid');
		expect(resolve(42)).toBe('invalid');
		expect(resolve('x'.repeat(201))).toBe('invalid');
		expect(resolve(`https://bioscale.app/r/BT-M01-0000-0230?${'p'.repeat(150)}`)).toBe('s230');
	});
	it('a UDI match wins over a label match on another reader; two label matches are ambiguous', () => {
		const rows: ReaderDoc[] = [
			{ _id: 'a', udi: 'BT-M01-0000-0001', barcode: 'BT-M01-0000-0002' },
			{ _id: 'b', udi: 'BT-M01-0000-0002' }
		];
		expect(pickReader(rows, codeValues('BT-M01-0000-0002')!)?._id).toBe('b');
		const dup: ReaderDoc[] = [
			{ _id: 'a', udi: 'U1', barcode: LABEL },
			{ _id: 'b', udi: 'U2', barcode: LABEL }
		];
		expect(pickReader(dup, codeValues(LABEL)!)).toBeNull();
	});
});

describe('pairing rules', () => {
	const doc = (over: Partial<ReaderDoc> = {}): ReaderDoc => ({ _id: 'x', udi: 'BT-M01-0000-0230', status: 'released', ...over });

	it('released and unheld: pair', () => expect(evaluatePair(doc(), ME)).toEqual({ action: 'pair' }));
	it('legacy released statuses count as released', () => {
		expect(isPairable('deployed')).toBe(true);
		expect(isPairable('released-field')).toBe(true);
	});
	it('held by this holder: already (whatever its status now)', () => {
		expect(evaluatePair(doc({ holder: { kind: 'app', ref: ME } }), ME)).toEqual({ action: 'already' });
		expect(evaluatePair(doc({ status: 'servicing', holder: { kind: 'app', ref: ME } }), ME)).toEqual({ action: 'already' });
	});
	it('held by another holder: held_by_other', () =>
		expect(evaluatePair(doc({ holder: { kind: 'app', ref: OTHER } }), ME)).toEqual({ action: 'refuse', reason: 'held_by_other' }));
	it.each(['draft', 'assembling', 'validating', 'servicing', 'retired', null, undefined, 'voided'])('status %s: not_available', (status) =>
		expect(evaluatePair(doc({ status: status as any }), ME)).toEqual({ action: 'refuse', reason: 'not_available' }));
	it('no reader: not_found', () => expect(evaluatePair(null, ME)).toEqual({ action: 'refuse', reason: 'not_found' }));

	it('unpair', () => {
		expect(evaluateUnpair(null, ME)).toEqual({ action: 'refuse', reason: 'not_found' });
		expect(evaluateUnpair(doc(), ME)).toEqual({ action: 'not_paired' });
		expect(evaluateUnpair(doc({ holder: { ref: OTHER } }), ME)).toEqual({ action: 'refuse', reason: 'held_by_other' });
		expect(evaluateUnpair(doc({ holder: { ref: ME } }), ME)).toEqual({ action: 'unpair' });
	});
	it('heldBy', () => {
		expect(heldBy(doc({ holder: { ref: ME } }), ME)).toBe(true);
		expect(heldBy(doc({ holder: { ref: OTHER } }), ME)).toBe(false);
		expect(heldBy(doc(), ME)).toBe(false);
		expect(heldBy(null, ME)).toBe(false);
	});
});

describe('appMessage', () => {
	it('says reader, not SPU', () => {
		expect(appMessage('SPU is busy (running a test or other routine). Try again when it is idle.')).toBe(
			'The reader is busy (running a test or other routine). Try again when it is idle.'
		);
		expect(appMessage('This SPU runs firmware older than v109.')).toBe('This reader runs firmware older than v109.');
		expect(appMessage("Could not read the SPU's Wi-Fi status.")).toBe('Could not read the reader’s Wi-Fi status.');
		expect(appMessage('Cellular is not connected on this SPU, so switching Wi-Fi could leave it unreachable.')).not.toMatch(/SPU/);
		expect(appMessage('The SPU has its Wi-Fi radio turned off.')).toBe('The reader has its Wi-Fi radio turned off.');
	});
	it('returns nothing of a message that carries the password', () => {
		const out = appMessage('failed: arg MyNet:::hunter2-secret:::3', 'hunter2-secret');
		expect(out).not.toContain('hunter2-secret');
	});
});
