/**
 * Cleaning recurrence expansion.
 *
 * Occurrences are identified by a lab-local calendar day key: 'YYYY-MM-DD'.
 * We deliberately do NOT store occurrence timestamps as Date objects -- a
 * cleaning that is "due Friday" is due on the lab's Friday, not at a UTC
 * instant. The server runs in UTC (Vercel), so "today" is resolved through
 * LAB_TIMEZONE rather than the host clock's local date.
 *
 * All key arithmetic is done in UTC so it is DST-proof: the keys are opaque
 * calendar labels, and UTC has no DST to skew day counts.
 */

export const LAB_TIMEZONE = 'America/Chicago';

const MS_DAY = 86_400_000;
const MAX_OCCURRENCES = 800; // safety valve against a pathological schedule

export type FrequencyKind = 'daily' | 'weekly' | 'monthly';

export interface Frequency {
	kind: FrequencyKind;
	interval?: number;
	daysOfWeek?: number[];
	dayOfMonth?: number;
}

export interface ScheduleLike {
	_id: string;
	frequency?: Frequency | null;
	startDate: string;
	endDate?: string | null;
}

/* ------------------------------------------------------------------ keys */

/** Calendar-day key for an instant, as seen in the lab's timezone. */
export function dateKey(d: Date = new Date(), timeZone: string = LAB_TIMEZONE): string {
	// 'en-CA' formats as YYYY-MM-DD, which is exactly our key format.
	return new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).format(d);
}

/** Today's key in the lab's timezone. */
export function todayKey(): string {
	return dateKey(new Date());
}

export function isValidKey(key: unknown): key is string {
	if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
	const [y, m, d] = key.split('-').map(Number);
	if (m < 1 || m > 12 || d < 1) return false;
	return d <= daysInMonth(y, m - 1);
}

export function isValidMonth(month: unknown): month is string {
	if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return false;
	const m = Number(month.slice(5, 7));
	return m >= 1 && m <= 12;
}

function keyToMs(key: string): number {
	const [y, m, d] = key.split('-').map(Number);
	return Date.UTC(y, m - 1, d);
}

function msToKey(ms: number): string {
	const d = new Date(ms);
	const y = String(d.getUTCFullYear()).padStart(4, '0');
	const m = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

export function addDays(key: string, n: number): string {
	return msToKey(keyToMs(key) + n * MS_DAY);
}

/** Whole days from `b` to `a` (a - b). */
export function diffDays(a: string, b: string): number {
	return Math.round((keyToMs(a) - keyToMs(b)) / MS_DAY);
}

/** 0=Sunday .. 6=Saturday */
export function weekday(key: string): number {
	return new Date(keyToMs(key)).getUTCDay();
}

export function daysInMonth(year: number, monthIndex: number): number {
	return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** First day of the week (Sunday) containing `key`. */
export function weekStart(key: string): string {
	return addDays(key, -weekday(key));
}

/** First and last day keys of a 'YYYY-MM' month. */
export function monthKeyRange(month: string): { start: string; end: string } {
	const [y, m] = month.split('-').map(Number);
	const yy = String(y).padStart(4, '0');
	const mm = String(m).padStart(2, '0');
	return {
		start: `${yy}-${mm}-01`,
		end: `${yy}-${mm}-${String(daysInMonth(y, m - 1)).padStart(2, '0')}`
	};
}

/** Shift a 'YYYY-MM' month by n months. */
export function addMonths(month: string, n: number): string {
	const [y, m] = month.split('-').map(Number);
	const total = y * 12 + (m - 1) + n;
	const ny = Math.floor(total / 12);
	const nm = total - ny * 12;
	return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}`;
}

/* ------------------------------------------------------------ expansion */

/**
 * Every occurrence key for `schedule` within [from, to] inclusive.
 * Returns sorted, de-duplicated keys.
 */
export function expandOccurrences(schedule: ScheduleLike, from: string, to: string): string[] {
	const start = schedule.startDate;
	if (!isValidKey(start) || !isValidKey(from) || !isValidKey(to)) return [];
	if (to < from) return [];

	// Clamp the requested window to the schedule's own lifetime.
	const lo = from > start ? from : start;
	const hi = schedule.endDate && schedule.endDate < to ? schedule.endDate : to;
	if (hi < lo) return [];

	const freq = schedule.frequency ?? { kind: 'weekly' as FrequencyKind };
	const kind: FrequencyKind = freq.kind ?? 'weekly';
	const interval = Math.max(1, Math.floor(freq.interval ?? 1));
	const out: string[] = [];

	if (kind === 'daily') {
		// First on-cadence day at or after `lo`.
		const offset = Math.max(0, diffDays(lo, start));
		const rem = offset % interval;
		let cur = addDays(start, offset + (rem === 0 ? 0 : interval - rem));
		while (cur <= hi && out.length < MAX_OCCURRENCES) {
			out.push(cur);
			cur = addDays(cur, interval);
		}
	} else if (kind === 'weekly') {
		const days = (freq.daysOfWeek?.length ? freq.daysOfWeek : [weekday(start)])
			.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
			.sort((a, b) => a - b);
		if (!days.length) return [];

		const anchorWeek = weekStart(start);
		let wk = weekStart(lo);
		if (wk < anchorWeek) wk = anchorWeek;
		const weeksOff = Math.round(diffDays(wk, anchorWeek) / 7);
		const rem = weeksOff % interval;
		if (rem !== 0) wk = addDays(wk, (interval - rem) * 7);

		while (wk <= hi && out.length < MAX_OCCURRENCES) {
			for (const dow of days) {
				const k = addDays(wk, dow);
				if (k >= lo && k <= hi) out.push(k);
			}
			wk = addDays(wk, interval * 7);
		}
	} else {
		// monthly
		const [sy, sm] = start.split('-').map(Number);
		const dom = Math.min(31, Math.max(1, Math.floor(freq.dayOfMonth ?? Number(start.slice(8, 10)))));
		const anchorMonths = sy * 12 + (sm - 1);

		const [ly, lm] = lo.split('-').map(Number);
		let cursor = ly * 12 + (lm - 1);
		if (cursor < anchorMonths) cursor = anchorMonths;
		const remM = (cursor - anchorMonths) % interval;
		if (remM !== 0) cursor += interval - remM;

		const [hy, hm] = hi.split('-').map(Number);
		const hiMonths = hy * 12 + (hm - 1);

		while (cursor <= hiMonths && out.length < MAX_OCCURRENCES) {
			const y = Math.floor(cursor / 12);
			const mIdx = cursor - y * 12;
			// Clamp: "the 31st" in a 30-day month means the 30th.
			const day = Math.min(dom, daysInMonth(y, mIdx));
			const k = `${String(y).padStart(4, '0')}-${String(mIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
			if (k >= lo && k <= hi) out.push(k);
			cursor += interval;
		}
	}

	return [...new Set(out)].sort();
}

const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Human-readable cadence, e.g. "Every 2 weeks on Mon, Thu". */
export function describeFrequency(freq?: Frequency | null): string {
	const kind = freq?.kind ?? 'weekly';
	const interval = Math.max(1, Math.floor(freq?.interval ?? 1));

	if (kind === 'daily') return interval === 1 ? 'Every day' : `Every ${interval} days`;

	if (kind === 'weekly') {
		const days = (freq?.daysOfWeek ?? [])
			.filter((d) => d >= 0 && d <= 6)
			.sort((a, b) => a - b);
		const on = days.length ? ` on ${days.map((d) => DAY_NAMES_SHORT[d]).join(', ')}` : '';
		return (interval === 1 ? 'Every week' : `Every ${interval} weeks`) + on;
	}

	const dom = freq?.dayOfMonth;
	const on = dom ? ` on day ${dom}` : '';
	return (interval === 1 ? 'Every month' : `Every ${interval} months`) + on;
}

export type OccurrenceState = 'completed' | 'skipped' | 'overdue' | 'due' | 'upcoming';

export function occurrenceState(
	dueDate: string,
	record: { status?: string } | null | undefined,
	today: string
): OccurrenceState {
	if (record?.status === 'completed') return 'completed';
	if (record?.status === 'skipped') return 'skipped';
	if (dueDate < today) return 'overdue';
	if (dueDate === today) return 'due';
	return 'upcoming';
}
