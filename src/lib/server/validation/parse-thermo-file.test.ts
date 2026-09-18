import { describe, it, expect } from 'vitest';
import { parseThermoFile } from './parse-thermo-file';

// End-to-end over the real spreadsheet reader: a logger export goes in as
// bytes, two probe series come out. parse-thermo.test.ts covers the column
// logic; this covers that the file reader hands it rows in the shape it wants.

function csv(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

describe('parseThermoFile', () => {
	const twoProbeCsv = [
		'Time,CH1,CH2',
		'2026-09-04 14:01:39,23.7,23.9',
		'2026-09-04 14:01:40,24.1,24.5',
		'2026-09-04 14:01:41,24.3,25.1'
	].join('\n');

	it('returns one series per probe from a real .csv', () => {
		const out = parseThermoFile(csv(twoProbeCsv));
		expect('error' in out).toBe(false);
		if ('error' in out) return;

		expect(out.channels).toHaveLength(2);
		expect(out.channels[0].readings.map(r => r.temperature)).toEqual([23.7, 24.1, 24.3]);
		expect(out.channels[1].readings.map(r => r.temperature)).toEqual([23.9, 24.5, 25.1]);
	});

	it('does not report a temperature that neither probe recorded', () => {
		const out = parseThermoFile(csv(twoProbeCsv));
		if ('error' in out) throw new Error(out.error);

		// The bug this replaces: both columns collapsed to their mean, so the
		// maximum came back as 24.7 — a value absent from the file.
		const everyRecordedValue = new Set([23.7, 24.1, 24.3, 23.9, 24.5, 25.1]);
		for (const channel of out.channels) {
			for (const reading of channel.readings) {
				expect(everyRecordedValue.has(reading.temperature)).toBe(true);
			}
		}
	});

	it('still reads a single-probe export as one channel', () => {
		const out = parseThermoFile(csv([
			'Time,Temp',
			'2026-09-04 14:01:39,23.7',
			'2026-09-04 14:01:40,24.1'
		].join('\n')));
		if ('error' in out) throw new Error(out.error);

		expect(out.channels).toHaveLength(1);
		expect(out.channels[0].readings.map(r => r.temperature)).toEqual([23.7, 24.1]);
		expect(out.readings.map(r => r.temperature)).toEqual([23.7, 24.1]);
	});

	it('rejects an empty file with a usable message', () => {
		const out = parseThermoFile(new Uint8Array());
		expect('error' in out).toBe(true);
	});
});
