/**
 * Staged rollout for the deck-calibration hardening.
 *
 * WHY
 * The fill robots are production equipment and there is no spare to test on.
 * Every behaviour change here — refusing a run whose deck is unbound, narrowing
 * the upload bundle, reloading labware whose version moved — is a change to how
 * a real robot behaves. Shipping them to all three at once means the first
 * unknown is discovered on a production fill.
 *
 * So none of it is on by default. `DECK_HARDENING_ROBOT_IDS` names the robots
 * the new behaviour applies to; every other robot keeps the exact code path it
 * has today. Unset means unset: nothing is enforced anywhere, which is what
 * makes this safe to merge to master before it is safe to enable.
 *
 *   DECK_HARDENING_ROBOT_IDS=CCyX8FjTRGvYOd9vISGvi     # by robot _id
 *   DECK_HARDENING_ROBOT_IDS=OT2CEP20210817R04         # or legacy id
 *   DECK_HARDENING_ROBOT_IDS=<id>,<id>                 # widen one at a time
 *
 * Observability is deliberately NOT gated — run records and warnings are
 * written for every robot, because they change nothing and are how you find out
 * whether the guard would have fired before you turn it on.
 */

/** Robot identifiers the hardening is enabled for. Empty set = disabled everywhere. */
export function hardenedRobotTokens(): Set<string> {
	const raw = process.env.DECK_HARDENING_ROBOT_IDS ?? '';
	return new Set(
		raw
			.split(',')
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean)
	);
}

/**
 * Is the new behaviour live for this robot?
 *
 * Matches the robot's `_id`, its `name`, or its `legacyRobotId`, case-
 * insensitively — an operator setting this reaches for "R04", not a nanoid, and
 * a rollout flag that is easy to set wrong is worse than no flag.
 */
export function isHardenedRobot(robot: unknown): boolean {
	const tokens = hardenedRobotTokens();
	if (!tokens.size) return false;

	const r = (robot ?? {}) as Record<string, unknown>;
	const candidates =
		typeof robot === 'string'
			? [robot]
			: [r._id, r.name, r.legacyRobotId, r.robotSerial].filter(Boolean);

	for (const c of candidates) {
		const v = String(c).toLowerCase();
		if (tokens.has(v)) return true;
		// Allow a whole-word match so "r04" selects "Robot 2 R04" / "OT2CEP...R04".
		for (const t of tokens) {
			if (t.length >= 3 && new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`).test(v)) {
				return true;
			}
		}
	}
	return false;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One-line description for logs, so a run's behaviour is explainable afterwards. */
export function rolloutNote(robot: unknown): string {
	return isHardenedRobot(robot)
		? 'deck-hardening ENABLED for this robot'
		: 'deck-hardening disabled for this robot (legacy behaviour)';
}
