import { describe, expect, it } from 'vitest';
import { addDays, isDay, labDay, mondayOf, tally, weekdays } from './checkin';

describe('labDay', () => {
	it('uses the Central calendar day, not UTC', () => {
		// 6:35 pm CST Monday Nov 16 is already Nov 17 in UTC.
		expect(labDay('2026-11-17T00:35:35Z')).toBe('2026-11-16');
		expect(labDay('2026-10-20T23:28:07Z')).toBe('2026-10-20'); // 6:28 pm CDT
	});

	it('a note just after midnight counts for the day that ended', () => {
		expect(labDay('2026-11-17T06:30:00Z')).toBe('2026-11-16'); // 12:30 am CST Tuesday
		expect(labDay('2026-11-17T10:30:00Z')).toBe('2026-11-17'); // 4:30 am CST Tuesday
	});
});

describe('weeks', () => {
	it('mondayOf / weekdays', () => {
		expect(mondayOf('2026-11-16')).toBe('2026-11-16');
		expect(mondayOf('2026-11-20')).toBe('2026-11-16');
		expect(mondayOf('2026-11-22')).toBe('2026-11-16'); // Sunday
		expect(weekdays('2026-11-16')).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
		expect(addDays('2026-11-30', 7)).toBe('2026-12-07');
	});

	it('isDay rejects junk', () => {
		expect(isDay('2026-11-16')).toBe(true);
		expect(isDay('2026-13-45')).toBe(false);
		expect(isDay('nope')).toBe(false);
	});
});

describe('tally', () => {
	it('counts notes per person per lab day, inside the week only', () => {
		const days = weekdays('2026-11-16');
		const t = tally(
			[
				{ speaker: { username: 'jacob' }, recordedAt: '2026-11-17T00:35:35Z' }, // Mon
				{ speaker: { username: 'jacob' }, recordedAt: '2026-11-17T01:00:00Z' }, // Mon again
				{ speaker: { username: 'gio' }, recordedAt: '2026-11-18T23:00:00Z' }, // Wed
				{ speaker: { username: 'gio' }, recordedAt: '2026-11-14T00:10:02Z' }, // previous Fri
				{ speaker: null, recordedAt: '2026-11-17T00:35:35Z' }
			],
			days
		);
		expect(t.get('jacob')?.get('2026-11-16')).toBe(2);
		expect(t.get('gio')?.get('2026-11-18')).toBe(1);
		expect(t.get('gio')?.size).toBe(1);
		expect(t.size).toBe(2);
	});
});
