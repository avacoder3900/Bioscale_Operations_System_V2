import {
	expandOccurrences,
	addDays,
	diffDays,
	weekday,
	weekStart,
	monthKeyRange,
	addMonths,
	isValidKey,
	describeFrequency,
	dateKey
} from '../src/lib/server/cleaning/recurrence';

let pass = 0;
let fail = 0;

function eq(label: string, actual: unknown, expected: unknown) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		pass++;
	} else {
		fail++;
		console.log(`FAIL ${label}\n  actual   ${a}\n  expected ${e}`);
	}
}

// --- key helpers
eq('addDays across month', addDays('2026-01-31', 1), '2026-02-01');
eq('addDays across year', addDays('2026-12-31', 1), '2027-01-01');
eq('addDays negative', addDays('2026-03-01', -1), '2026-02-28');
eq('leap year 2028', addDays('2028-02-28', 1), '2028-02-29');
eq('diffDays', diffDays('2026-03-01', '2026-02-01'), 28);
eq('weekday 2026-08-26 is Wed', weekday('2026-08-26'), 3);
eq('weekStart Sunday', weekStart('2026-08-26'), '2026-08-23');
eq('monthKeyRange feb 2026', monthKeyRange('2026-02'), { start: '2026-02-01', end: '2026-02-28' });
eq('addMonths forward', addMonths('2026-11', 3), '2027-02');
eq('addMonths backward', addMonths('2026-01', -1), '2025-12');
eq('addMonths back a year', addMonths('2026-01', -13), '2024-12');
eq('isValidKey rejects feb 30', isValidKey('2026-02-30'), false);
eq('isValidKey accepts', isValidKey('2026-08-26'), true);
eq('isValidKey rejects junk', isValidKey('2026-8-26'), false);

// --- daily
eq(
	'daily every day',
	expandOccurrences({ _id: 'a', frequency: { kind: 'daily' }, startDate: '2026-08-24' }, '2026-08-24', '2026-08-27'),
	['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27']
);
eq(
	'daily interval 3, window starts mid-cadence',
	expandOccurrences(
		{ _id: 'a', frequency: { kind: 'daily', interval: 3 }, startDate: '2026-08-01' },
		'2026-08-06',
		'2026-08-14'
	),
	['2026-08-07', '2026-08-10', '2026-08-13']
);
eq(
	'daily respects endDate',
	expandOccurrences(
		{ _id: 'a', frequency: { kind: 'daily' }, startDate: '2026-08-24', endDate: '2026-08-25' },
		'2026-08-01',
		'2026-12-01'
	),
	['2026-08-24', '2026-08-25']
);
eq(
	'window before start yields nothing',
	expandOccurrences({ _id: 'a', frequency: { kind: 'daily' }, startDate: '2026-09-01' }, '2026-08-01', '2026-08-31'),
	[]
);

// --- weekly
eq(
	'weekly Mon+Thu',
	expandOccurrences(
		{ _id: 'a', frequency: { kind: 'weekly', daysOfWeek: [1, 4] }, startDate: '2026-08-01' },
		'2026-08-24',
		'2026-09-04'
	),
	['2026-08-24', '2026-08-27', '2026-08-31', '2026-09-03']
);
eq(
	'weekly every 2 weeks Fri, anchored on start week',
	expandOccurrences(
		{ _id: 'a', frequency: { kind: 'weekly', interval: 2, daysOfWeek: [5] }, startDate: '2026-08-03' },
		'2026-08-01',
		'2026-09-30'
	),
	['2026-08-07', '2026-08-21', '2026-09-04', '2026-09-18']
);
eq(
	'weekly with no daysOfWeek falls back to start weekday',
	expandOccurrences({ _id: 'a', frequency: { kind: 'weekly' }, startDate: '2026-08-26' }, '2026-08-01', '2026-09-16'),
	['2026-08-26', '2026-09-02', '2026-09-09', '2026-09-16']
);
// startDate 2026-08-26 is itself a Wednesday, so it counts; Mon 08-24 does not.
eq(
	'weekly clips the start week to days on or after startDate',
	expandOccurrences(
		{ _id: 'a', frequency: { kind: 'weekly', daysOfWeek: [1, 3, 5] }, startDate: '2026-08-26' },
		'2026-08-01',
		'2026-08-31'
	),
	['2026-08-26', '2026-08-28', '2026-08-31']
);
// ...and when startDate falls after the listed day, that day is skipped.
eq(
	'weekly skips start-week days before startDate',
	expandOccurrences(
		{ _id: 'a', frequency: { kind: 'weekly', daysOfWeek: [1, 3] }, startDate: '2026-08-27' },
		'2026-08-01',
		'2026-09-02'
	),
	['2026-08-31', '2026-09-02']
);

// --- monthly
eq(
	'monthly day 15',
	expandOccurrences(
		{ _id: 'a', frequency: { kind: 'monthly', dayOfMonth: 15 }, startDate: '2026-01-15' },
		'2026-08-01',
		'2026-10-31'
	),
	['2026-08-15', '2026-09-15', '2026-10-15']
);
eq(
	'monthly day 31 clamps to short months',
	expandOccurrences(
		{ _id: 'a', frequency: { kind: 'monthly', dayOfMonth: 31 }, startDate: '2026-01-31' },
		'2026-02-01',
		'2026-04-30'
	),
	['2026-02-28', '2026-03-31', '2026-04-30']
);
eq(
	'monthly quarterly',
	expandOccurrences(
		{ _id: 'a', frequency: { kind: 'monthly', interval: 3, dayOfMonth: 1 }, startDate: '2026-01-01' },
		'2026-01-01',
		'2026-12-31'
	),
	['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01']
);

// --- descriptions
eq('describe daily 1', describeFrequency({ kind: 'daily' }), 'Every day');
eq('describe weekly 2 Mon Thu', describeFrequency({ kind: 'weekly', interval: 2, daysOfWeek: [1, 4] }), 'Every 2 weeks on Mon, Thu');
eq('describe monthly', describeFrequency({ kind: 'monthly', dayOfMonth: 15 }), 'Every month on day 15');

// --- timezone: an instant that is a different calendar day in UTC vs Chicago
eq('lab day for 2026-08-27T02:00Z is still the 26th', dateKey(new Date('2026-08-27T02:00:00Z')), '2026-08-26');
eq('lab day for 2026-08-27T14:00Z is the 27th', dateKey(new Date('2026-08-27T14:00:00Z')), '2026-08-27');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
