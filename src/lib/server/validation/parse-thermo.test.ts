import { describe, it, expect } from 'vitest';
import { parseThermoRows } from './parse-thermo';

// The loggers export one column per probe. This suite pins down that each
// probe survives parsing as its own series — the defect being fixed here is
// that two columns were averaged into a single number, so BIMS reported a
// temperature that neither probe ever read.

const TZ = 0; // resolve naive wall-clock text as UTC so assertions are stable

describe('parseThermoRows — two-channel exports', () => {
	const twoChannel: unknown[][] = [
		['Time', 'CH1', 'CH2'],
		['2026-09-04T14:01:39', 23.7, 23.9],
		['2026-09-04T14:01:40', 24.1, 24.5],
		['2026-09-04T14:01:41', 24.3, 25.1]
	];

	it('keeps each probe as its own series instead of averaging them', () => {
		const r = parseThermoRows(twoChannel, TZ);

		expect(r.error).toBeUndefined();
		expect(r.channels).toHaveLength(2);

		expect(r.channels[0].readings.map(x => x.temperature)).toEqual([23.7, 24.1, 24.3]);
		expect(r.channels[1].readings.map(x => x.temperature)).toEqual([23.9, 24.5, 25.1]);
	});

	it('labels channels from the file\'s own headers', () => {
		const r = parseThermoRows(twoChannel, TZ);
		expect(r.channels.map(c => c.label)).toEqual(['CH1', 'CH2']);
		expect(r.channels.map(c => c.key)).toEqual(['ch1', 'ch2']);
		// Columns B and C.
		expect(r.channels.map(c => c.column)).toEqual([1, 2]);
	});

	it('gives every channel the same timestamps, in the same order', () => {
		const r = parseThermoRows(twoChannel, TZ);
		const [a, b] = r.channels;
		expect(a.readings.map(x => x.timestamp)).toEqual(b.readings.map(x => x.timestamp));
		// Ascending, so the charts read left to right.
		const ts = a.readings.map(x => x.timestamp);
		expect([...ts].sort((x, y) => x - y)).toEqual(ts);
	});

	it('sorts every channel consistently when the file is out of order', () => {
		const shuffled: unknown[][] = [
			['Time', 'CH1', 'CH2'],
			['2026-09-04T14:01:41', 24.3, 25.1],
			['2026-09-04T14:01:39', 23.7, 23.9],
			['2026-09-04T14:01:40', 24.1, 24.5]
		];
		const r = parseThermoRows(shuffled, TZ);
		// Each row's two values must stay paired with each other after sorting.
		expect(r.channels[0].readings.map(x => x.temperature)).toEqual([23.7, 24.1, 24.3]);
		expect(r.channels[1].readings.map(x => x.temperature)).toEqual([23.9, 24.5, 25.1]);
	});

	it('still reports the combined mean series for backward compatibility', () => {
		const r = parseThermoRows(twoChannel, TZ);
		expect(r.readings.map(x => x.temperature)).toEqual([
			(23.7 + 23.9) / 2,
			(24.1 + 24.5) / 2,
			(24.3 + 25.1) / 2
		]);
	});

	it('names both columns in the operator-facing note', () => {
		const r = parseThermoRows(twoChannel, TZ);
		expect(r.columnsNote).toContain('2 channels');
		expect(r.columnsNote).toContain('B');
		expect(r.columnsNote).toContain('C');
	});

	it('names the source column when two probes share a header', () => {
		const r = parseThermoRows([
			['Time', 'Temp', 'Temp'],
			['2026-09-04T14:01:39', 23.7, 23.9],
			['2026-09-04T14:01:40', 24.1, 24.5]
		], TZ);
		// Two blocks both titled "Temp" would be indistinguishable in the UI.
		expect(r.channels[0].label).not.toBe(r.channels[1].label);
		expect(r.channels[0].label).toContain('B');
		expect(r.channels[1].label).toContain('C');
	});

	it('does not mix a file header with a positional fallback name', () => {
		const r = parseThermoRows([
			['Time', 'A temperature column header that is really very long indeed', 'CH2'],
			['2026-09-04T14:01:39', 23.7, 23.9],
			['2026-09-04T14:01:40', 24.1, 24.5]
		], TZ);
		// One channel falling back to "Channel 1" beside a sibling labelled
		// "CH2" reads like an off-by-one in probe numbering.
		expect(r.channels).toHaveLength(2);
		for (const c of r.channels) expect(c.label).toMatch(/col [BC]/);
	});

	it('keeps channels aligned when one probe drops a sample', () => {
		const gappy: unknown[][] = [
			['Time', 'CH1', 'CH2'],
			['2026-09-04T14:01:39', 23.7, 23.9],
			['2026-09-04T14:01:40', 24.1, null],
			['2026-09-04T14:01:41', 24.3, 25.1]
		];
		const r = parseThermoRows(gappy, TZ);
		expect(r.channels[0].readings).toHaveLength(3);
		// The blank contributes no point rather than a fabricated one.
		expect(r.channels[1].readings.map(x => x.temperature)).toEqual([23.9, 25.1]);
		// The row still counts for the channel that did report.
		expect(r.readings[1].temperature).toBe(24.1);
	});
});

describe('parseThermoRows — single-channel exports are unchanged', () => {
	const oneChannel: unknown[][] = [
		['Time', 'Temp'],
		['2026-09-04T14:01:39', 23.7],
		['2026-09-04T14:01:40', 24.1],
		['2026-09-04T14:01:41', 24.3]
	];

	it('yields exactly one channel whose readings are the raw values', () => {
		const r = parseThermoRows(oneChannel, TZ);
		expect(r.channels).toHaveLength(1);
		expect(r.channels[0].readings.map(x => x.temperature)).toEqual([23.7, 24.1, 24.3]);
	});

	it('leaves the combined series identical to the single column', () => {
		const r = parseThermoRows(oneChannel, TZ);
		expect(r.readings.map(x => x.temperature)).toEqual([23.7, 24.1, 24.3]);
	});
});

describe('parseThermoRows — existing QC guards still hold', () => {
	it('ignores a title row above the header (VALIDATION-05)', () => {
		const titled: unknown[][] = [
			['温度 datasheet', null, null],
			['Time', 'CH1', 'CH2'],
			['2026-09-04T14:01:39', 23.7, 23.9],
			['2026-09-04T14:01:40', 24.1, 24.5]
		];
		const r = parseThermoRows(titled, TZ);
		expect(r.error).toBeUndefined();
		expect(r.channels[0].readings.map(x => x.temperature)).toEqual([23.7, 24.1]);
		expect(r.channels[1].readings.map(x => x.temperature)).toEqual([23.9, 24.5]);
	});

	it('does not read a row-index column as a temperature', () => {
		const indexed: unknown[][] = [
			['num', 'Time', 'CH1'],
			[1, '2026-09-04T14:01:39', 23.7],
			[2, '2026-09-04T14:01:40', 24.1],
			[3, '2026-09-04T14:01:41', 24.3]
		];
		const r = parseThermoRows(indexed, TZ);
		expect(r.error).toBeUndefined();
		// Only the real probe column becomes a channel; 1,2,3 is not a probe.
		expect(r.channels).toHaveLength(1);
		expect(r.channels[0].readings.map(x => x.temperature)).toEqual([23.7, 24.1, 24.3]);
	});

	it('reports an error when no column holds temperatures', () => {
		const r = parseThermoRows([['a', 'b'], ['x', 'y'], ['p', 'q']], TZ);
		expect(r.error).toBeDefined();
		expect(r.channels).toEqual([]);
	});
});
