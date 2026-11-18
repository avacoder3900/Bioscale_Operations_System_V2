/**
 * VOICE-01: the EOD check-in grid (/kanban/eod) — who sent an end-of-day note on
 * which weekday. Pure date helpers, unit-tested in checkin.test.ts.
 *
 * A "lab day" is the US Central calendar day, with a 4 a.m. cutoff: a note
 * recorded at 12:30 a.m. still counts for the day that just ended.
 */

const LAB_TZ = 'America/Chicago';
const CUTOFF_HOURS = 4;
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: LAB_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** YYYY-MM-DD lab day a moment belongs to. */
export function labDay(at: Date | string | number): string {
	return dayFmt.format(new Date(new Date(at).getTime() - CUTOFF_HOURS * 3_600_000));
}

const noonUtc = (day: string) => new Date(`${day}T12:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
	const d = noonUtc(day);
	d.setUTCDate(d.getUTCDate() + n);
	return iso(d);
}

/** Monday of the week containing `day` (weekend days belong to the week before them). */
export function mondayOf(day: string): string {
	const dow = noonUtc(day).getUTCDay(); // 0 Sun … 6 Sat
	return addDays(day, -((dow + 6) % 7));
}

/** Monday … Friday of the week starting at `monday`. */
export const weekdays = (monday: string): string[] => [0, 1, 2, 3, 4].map((i) => addDays(monday, i));

export const isDay = (s: unknown): s is string =>
	typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(noonUtc(s).getTime());

/** username → lab day → number of notes, for notes inside the given days. */
export function tally(
	memos: { speaker?: { username?: string } | null; recordedAt: Date | string }[],
	days: string[]
): Map<string, Map<string, number>> {
	const out = new Map<string, Map<string, number>>();
	for (const m of memos) {
		const who = m.speaker?.username;
		const day = labDay(m.recordedAt);
		if (!who || !days.includes(day)) continue;
		const row = out.get(who) ?? new Map<string, number>();
		row.set(day, (row.get(day) ?? 0) + 1);
		out.set(who, row);
	}
	return out;
}
