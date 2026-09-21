import { describe, it, expect } from 'vitest';
import { extractMagTestTime, pullDelaySeconds } from './magnetometer-time';

// Shapes taken verbatim from production payloads (probed 2026-07-30).
const FILENAME_PAYLOAD = [
	'/validation/magnet-1784661523.txt',
	'Channel A\t\t\t Channel B\t\t\t Channel C',
	'1\t25.1\t10\t20\t4100\t25.2\t11\t21\t4150\t25.3\t12\t22\t4200'
].join('\n');

const COUNTER_PAYLOAD = ['#003\t1710268200', '1\t25.1\t10\t20\t4100'].join('\n');

// The legacy shape, which never carried a timestamp at all.
const LEGACY_PAYLOAD = [
	'Channel A\t\t\t Channel B\t\t\t Channel C',
	'1\t25.1\t10\t20\t4100\t25.2\t11\t21\t4150\t25.3\t12\t22\t4200'
].join('\n');

describe('extractMagTestTime', () => {
	it('reads the epoch out of the results filename', () => {
		const r = extractMagTestTime(FILENAME_PAYLOAD)!;
		expect(r).not.toBeNull();
		expect(r.source).toBe('filename');
		expect(r.epoch).toBe(1784661523);
		expect(r.at.toISOString()).toBe(new Date(1784661523 * 1000).toISOString());
	});

	it('reads the epoch out of a counter header', () => {
		const r = extractMagTestTime(COUNTER_PAYLOAD)!;
		expect(r.source).toBe('counter');
		expect(r.epoch).toBe(1710268200);
	});

	it('prefers the filename when a payload somehow carries both', () => {
		const both = `#003\t1710268200\n/validation/magnet-1784661523.txt`;
		expect(extractMagTestTime(both)!.source).toBe('filename');
	});

	it('returns null for the legacy payload rather than inventing a time', () => {
		// This is the whole point: 13 production sessions look like this, and
		// falling back to the pull time is the bug being fixed.
		expect(extractMagTestTime(LEGACY_PAYLOAD)).toBeNull();
	});

	it('returns null for empty, missing, or non-string input', () => {
		expect(extractMagTestTime('')).toBeNull();
		expect(extractMagTestTime(null)).toBeNull();
		expect(extractMagTestTime(undefined)).toBeNull();
		expect(extractMagTestTime(12345)).toBeNull();
		expect(extractMagTestTime({ rawData: 'x' })).toBeNull();
	});

	it('rejects an unset device clock instead of reporting 1970 or 2001', () => {
		expect(extractMagTestTime('/validation/magnet-000000000.txt')).toBeNull();
		// A device that came up at the 2001 epoch default.
		expect(extractMagTestTime('/validation/magnet-978307200.txt')).toBeNull();
	});

	it('rejects a timestamp far in the future', () => {
		const future = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
		expect(extractMagTestTime(`/validation/magnet-${future}.txt`)).toBeNull();
	});

	it('allows a little forward clock skew', () => {
		const soon = Math.floor(Date.now() / 1000) + 60;
		expect(extractMagTestTime(`/validation/magnet-${soon}.txt`)).not.toBeNull();
	});

	it('accepts millisecond epochs as well as seconds', () => {
		const ms = 1784661523000;
		const r = extractMagTestTime(`/validation/magnet-${ms}.txt`)!;
		expect(r.at.toISOString()).toBe(new Date(ms).toISOString());
	});

	it('ignores epoch-looking numbers in the results table', () => {
		// Reading values must never be mistaken for a timestamp.
		const noHeader = ['1\t25.1\t1784661523\t20\t4100', '2\t25.2\t1784661999\t21\t4150'].join('\n');
		expect(extractMagTestTime(noHeader)).toBeNull();
	});

	it('finds the real production case: a stale pull, months after the test', () => {
		// SPU-0222 in prod: ran 2025-10-06, recorded as 2026-06-11.
		const raw = '/validation/magnet-1759767269.txt\nChannel A\t\t\t Channel B';
		const r = extractMagTestTime(raw)!;
		expect(r.at.getUTCFullYear()).toBe(2025);
		expect(r.at.getUTCMonth()).toBe(9); // October
	});
});

describe('pullDelaySeconds', () => {
	it('measures how long after the test the reading was taken', () => {
		const test = new Date('2026-07-29T21:00:10Z');
		const pull = new Date('2026-07-29T21:00:48Z');
		expect(pullDelaySeconds(test, pull)).toBe(38);
	});

	it('clamps backwards skew to zero rather than reporting a negative age', () => {
		const test = new Date('2026-07-29T21:00:48Z');
		const pull = new Date('2026-07-29T21:00:10Z');
		expect(pullDelaySeconds(test, pull)).toBe(0);
	});

	it('is null when either side is unknown', () => {
		expect(pullDelaySeconds(null, new Date())).toBeNull();
		expect(pullDelaySeconds(new Date(), null)).toBeNull();
	});
});
