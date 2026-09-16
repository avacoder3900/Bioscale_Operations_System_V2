// Shared optical-confirmation constants. Kept out of +page.server.ts because
// SvelteKit restricts what those modules may export, and both the log page and the
// analyze page need these.

/**
 * The single optical-confirmation assay in use: "Gen 5 Optical Scan - Start
 * Position Corrected". Change this id if a different optical assay is adopted.
 */
export const OPTICAL_ASSAY_ID = 'A9EB41AD';

/**
 * The other optical validation assays (created 2026-09-15, scripts/create-validation-assays.ts).
 *  - PHOTOBLEACH: 10 coarse sweeps of the same 4.1 mm with 30 s pauses; BIMS reads
 *    each sweep as one point per channel (see analyzePhotobleach).
 *  - BLANK: the single scan under its own id, run from a BLANK- barcode on a
 *    reusable blank cartridge; results arrive over a webhook, never as a
 *    cartridge record, so it is deliberately NOT in OPTICAL_CARTRIDGE_FILTER.
 */
export const PHOTOBLEACH_ASSAY_ID = 'AF233F18';
export const BLANK_ASSAY_ID = 'A87934B1';

export type OpticalKind = 'scan' | 'photobleach';
export const OPTICAL_VALIDATION_ASSAYS: ReadonlyArray<{ id: string; kind: OpticalKind; label: string }> = [
	{ id: OPTICAL_ASSAY_ID, kind: 'scan', label: 'Single scan (42 positions)' },
	{ id: PHOTOBLEACH_ASSAY_ID, kind: 'photobleach', label: 'Photobleach (10 coarse sweeps, 30 s apart)' }
];
export function opticalKindFor(assayId: string | null | undefined): OpticalKind | null {
	return OPTICAL_VALIDATION_ASSAYS.find((a) => a.id === assayId)?.kind ?? null;
}

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
	$or: [{ assayCategory: 'optical_test' }, { assayId: { $in: [OPTICAL_ASSAY_ID, PHOTOBLEACH_ASSAY_ID] } }]
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

/**
 * Cap on how many cartridges one comparison may pull. Each carries ~126 readings.
 * 130 fits two full fleet batches (2 carts × 32 units = 64) side by side.
 */
export const MAX_COMPARE_CARTRIDGES = 130;
