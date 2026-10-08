/**
 * Reagent well-issue vocabulary shared by the run-page tracker, the history
 * heatmap and the server actions. Client-safe (no Mongoose). The server-side
 * enum on ReagentBatchRecord.wellIssues[].issue is the same list — keep them in
 * step (the action validates against this one before writing).
 */
export const REAGENT_WELL_ISSUE_DEFS = [
	{ code: 'no_fill', label: 'No fill', short: 'Empty', hint: 'Well stayed empty' },
	{ code: 'partial_fill', label: 'Partial fill', short: 'Low', hint: 'Visibly short volume' },
	{ code: 'overfill', label: 'Overfill', short: 'Over', hint: 'Pooled over the rim' },
	{ code: 'missed_hole', label: 'Missed the hole', short: 'Miss', hint: 'Dispensed on the rim / beside the hole' },
	{ code: 'splash', label: 'Splash / droplet', short: 'Splash', hint: 'Droplets on the surface or wall' },
	{ code: 'bubble', label: 'Bubble', short: 'Bubble', hint: 'Air bubble in the well' },
	{ code: 'bent_tip', label: 'Bent tip', short: 'Bent', hint: 'Tip bent going in — fill suspect' },
	{ code: 'other', label: 'Other', short: 'Other', hint: 'Describe in the note' }
] as const;

export type ReagentWellIssueCode = (typeof REAGENT_WELL_ISSUE_DEFS)[number]['code'];

export const REAGENT_WELL_ISSUE_CODES: readonly string[] = REAGENT_WELL_ISSUE_DEFS.map((d) => d.code);

export function issueLabel(code: string): string {
	return REAGENT_WELL_ISSUE_DEFS.find((d) => d.code === code)?.label ?? code;
}
export function issueShort(code: string): string {
	return REAGENT_WELL_ISSUE_DEFS.find((d) => d.code === code)?.short ?? code;
}

/**
 * The four reagent wells of a Gen7 cartridge, in the order the protocol fills
 * them. Numbering matches the .py's well_2..well_5 RTPs and the assay
 * definition's reagents[].wellPosition.
 */
export const REAGENT_WELLS = [
	{ well: 2, label: 'Well 2', defaultName: 'Beads' },
	{ well: 3, label: 'Well 3', defaultName: 'Tracer' },
	{ well: 4, label: 'Well 4', defaultName: 'Wash' },
	{ well: 5, label: 'Well 5', defaultName: 'Elution' }
] as const;

/** Deck layout shared with DeckLoadingGrid: 8 rows × 3 carriers, vertical snake. */
export const REAGENT_DECK_ROWS: readonly (readonly [number, number, number])[] = [
	[1, 16, 17],
	[2, 15, 18],
	[3, 14, 19],
	[4, 13, 20],
	[5, 12, 21],
	[6, 11, 22],
	[7, 10, 23],
	[8, 9, 24]
];

export interface ReagentWellIssueRow {
	id: string;
	deckPosition: number;
	cartridgeId: string | null;
	well: number;
	reagentName: string | null;
	issue: string;
	note: string | null;
	loggedBy: string | null;
	loggedAt: string | null;
}

/**
 * Map a reagent-run (deckPosition 1–24, well 2–5) onto the gen4deck_gen7cartridge
 * labware wells it was filled into, so a tracker entry can be drawn on the
 * Deck Calibration Studio.
 *
 * Geometry (from Reagent_Filling_GEN7.py `params` / `rows`): the deck labware is
 * 24 rows (A front … X back) × 24 columns; reagent columns are odd —
 * well 5 (elution) → col 1, well 4 (wash) → 3, well 3 (tracer) → 5, well 2
 * (beads) → 7, plus 8 per carrier. A cartridge spans 3 rows (its three
 * channels). The scan sweep walks carrier 1 back→front (slots 1–8), carrier 2
 * front→back (9–16), carrier 3 back→front (17–24) — the same order the
 * protocol fills in, so slot n is the protocol's n-th cartridge:
 *   carrier 1/3: slot i (0-based in carrier) = rows X-3i, W-3i, V-3i
 *   carrier 2:   slot i = rows A+3i, B+3i, C+3i
 * Verified against B07/R04/B14 scanner position sets (slot 1 y≈319 = back,
 * slot 9 y≈89 = front) and the deck-004 definition (row X y≈257 = back).
 */
export const REAGENT_WELL_BASE_COL: Record<number, number> = { 5: 1, 4: 3, 3: 5, 2: 7 };
const ROW_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWX';

export function labwareWellsFor(deckPosition: number, well: number): string[] {
	if (!(deckPosition >= 1 && deckPosition <= 24)) return [];
	const baseCol = REAGENT_WELL_BASE_COL[well];
	if (!baseCol) return [];
	const carrier = Math.floor((deckPosition - 1) / 8); // 0,1,2
	const i = (deckPosition - 1) % 8;
	const col = baseCol + 8 * carrier;
	const rowIdx = carrier === 1 ? [3 * i, 3 * i + 1, 3 * i + 2] : [23 - 3 * i, 22 - 3 * i, 21 - 3 * i];
	return rowIdx.map((r) => `${ROW_LETTERS[r]}${col}`);
}

/** Inverse: which (deckPosition, well) a labware well belongs to, or null for wax/odd cases. */
export function deckPositionOfWell(wellName: string): { deckPosition: number; well: number } | null {
	const m = /^([A-X])(\d+)$/.exec(wellName);
	if (!m) return null;
	const rowIdx = ROW_LETTERS.indexOf(m[1]);
	const col = Number(m[2]);
	const carrier = Math.floor((col - 1) / 8);
	const baseCol = col - 8 * carrier;
	const well = Number(Object.keys(REAGENT_WELL_BASE_COL).find((k) => REAGENT_WELL_BASE_COL[Number(k)] === baseCol));
	if (!well) return null;
	const i = carrier === 1 ? Math.floor(rowIdx / 3) : Math.floor((23 - rowIdx) / 3);
	return { deckPosition: carrier * 8 + i + 1, well };
}
