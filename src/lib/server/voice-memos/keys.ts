/**
 * VOICE-01: per-person Voicenotes webhook keys.
 *
 * Voicenotes cannot send headers or sign requests, so the secret rides in the
 * URL: /api/webhooks/voicenotes?key=<secret>. One key per person, so the key
 * itself says who is speaking — the payload is never trusted for identity.
 *
 *   VOICENOTES_WEBHOOK_KEYS = "jacob:<secret>,someone:<secret2>"
 *
 * Generate a secret with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
 * Revoke one person by removing their entry. Keys are a webhook-only credential:
 * they reach this one endpoint and nothing else.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export interface KeyEntry {
	username: string;
	key: string;
}

export function parseKeyMap(raw: string | undefined): KeyEntry[] {
	if (!raw) return [];
	return raw
		.split(',')
		.map((pair) => {
			const i = pair.indexOf(':');
			if (i <= 0) return null;
			const username = pair.slice(0, i).trim();
			const key = pair.slice(i + 1).trim();
			return username && key ? { username, key } : null;
		})
		.filter((e): e is KeyEntry => e !== null);
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Username for a presented key, or null. Hashing first makes every comparison
 * fixed-length, and every entry is checked, so timing reveals nothing.
 */
export function usernameForKey(presented: string | null, entries: KeyEntry[]): string | null {
	if (!presented) return null;
	const p = digest(presented);
	let match: string | null = null;
	for (const e of entries) {
		if (timingSafeEqual(p, digest(e.key)) && match === null) match = e.username;
	}
	return match;
}
