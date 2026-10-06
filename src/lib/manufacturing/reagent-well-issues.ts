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
