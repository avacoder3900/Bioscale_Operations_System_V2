// Shared optical-confirmation constants. Kept out of +page.server.ts because
// SvelteKit restricts what those modules may export, and both the log page and the
// analyze page need these.

/**
 * The single optical-confirmation assay in use: "Gen 5 Optical Scan - Start
 * Position Corrected". Change this id if a different optical assay is adopted.
 */
export const OPTICAL_ASSAY_ID = 'A9EB41AD';

/**
 * Mongo filter for "this is an optical cartridge".
 *
 * Two populations are merged so group analysis has a usable N:
 *   1. assayCategory 'optical_test' — formally assigned via the log page.
 *   2. assayId OPTICAL_ASSAY_ID     — the same assay run from the bench/research app.
 *      Untagged, but the readings are identical in shape, so they are valid comparators.
 */
// Not `as const`: that makes $or a readonly tuple, which Mongoose's Filter type
// rejects because it expects a mutable array.
export const OPTICAL_CARTRIDGE_FILTER: Record<string, unknown> = {
	$or: [{ assayCategory: 'optical_test' }, { assayId: OPTICAL_ASSAY_ID }]
};

/**
 * Group colour identifiers. These are palette KEYS, not hex values: Tailwind cannot
 * generate a class from a runtime string, so interpolating a hex silently renders no
 * colour at all. Red is excluded — it reads as an error state.
 */
export const GROUP_COLOR_KEYS = ['cyan', 'green', 'purple', 'yellow', 'orange', 'blue'] as const;
export type GroupColorKey = (typeof GROUP_COLOR_KEYS)[number];

export function isGroupColorKey(v: unknown): v is GroupColorKey {
	return typeof v === 'string' && (GROUP_COLOR_KEYS as readonly string[]).includes(v);
}

/** Next unused palette key, falling back to round-robin once all are taken. */
export function nextGroupColor(used: Array<string | null | undefined>): GroupColorKey {
	const taken = new Set(used.filter(Boolean) as string[]);
	const free = GROUP_COLOR_KEYS.find((k) => !taken.has(k));
	return free ?? GROUP_COLOR_KEYS[taken.size % GROUP_COLOR_KEYS.length];
}

/** Cap on how many cartridges one comparison may pull. Each carries ~126 readings. */
export const MAX_COMPARE_CARTRIDGES = 60;
