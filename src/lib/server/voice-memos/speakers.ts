/**
 * VOICE-01: who an EOD note belongs to, from the initials in its title.
 *
 * "EOD JQ" / "End of Day GV" / "AV EOD" → the note is filed under that person,
 * whichever webhook key delivered it. So the whole team can share one webhook
 * URL (or use their own) and the notes still land in per-person piles.
 *
 * Initials come from the BIMS user's first + last name (Jacob Quick → JQ).
 * VOICENOTES_INITIALS overrides or adds ("JQ:jacob,GV:Giovanni Victorio") for
 * nicknames, middle initials, or two people who share initials.
 *
 * Pure functions — unit-tested in speakers.test.ts.
 */

export interface SpeakerUser {
	_id: string;
	username: string;
	firstName?: string | null;
	lastName?: string | null;
}

const firstLetter = (s: string | null | undefined) => /[a-z]/i.exec(s ?? '')?.[0]?.toUpperCase() ?? '';

/** JQ for Jacob Quick; null when either name is missing. */
export function initialsOf(u: Pick<SpeakerUser, 'firstName' | 'lastName'>): string | null {
	const a = firstLetter(u.firstName);
	const b = firstLetter(u.lastName);
	return a && b ? a + b : null;
}

/** "JQ:jacob,GV:Giovanni Victorio" → Map { JQ → jacob, GV → Giovanni Victorio }. */
export function parseInitialsMap(raw: string | undefined): Map<string, string> {
	const out = new Map<string, string>();
	for (const pair of (raw ?? '').split(',')) {
		const i = pair.indexOf(':');
		if (i <= 0) continue;
		const initials = pair.slice(0, i).trim().toUpperCase();
		const username = pair.slice(i + 1).trim();
		if (initials && username) out.set(initials, username);
	}
	return out;
}

/**
 * First candidate that names exactly one person. An override wins; otherwise the
 * initials must match one active user's name — two matches is ambiguous and is
 * skipped rather than guessed.
 */
export function resolveInitials(
	candidates: string[],
	users: SpeakerUser[],
	overrides: Map<string, string> = new Map()
): { user: SpeakerUser; initials: string } | null {
	for (const raw of candidates) {
		const initials = raw.toUpperCase();
		const named = overrides.get(initials);
		if (named) {
			const user = users.find((u) => u.username.toLowerCase() === named.toLowerCase());
			if (user) return { user, initials };
			continue;
		}
		const matches = users.filter((u) => initialsOf(u) === initials);
		if (matches.length === 1) return { user: matches[0], initials };
	}
	return null;
}
