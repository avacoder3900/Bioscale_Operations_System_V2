/**
 * BIMS API v1 — the analytes the customer apps can show, and which cartridge
 * wells (optical channels) are reported for each. Mirrors the customer apps'
 * `src/lib/analytes.ts` (`assayPattern`, `reportedWells`); when the shared
 * package exists (docs/BIMS-API-V1.md, "Later") this table moves there.
 *
 * The reader measures every well. A well not listed here never contributes a
 * value, a range status, a QC verdict or a flag to a result.
 */

export type WellId = 'A' | 'B' | 'C';
export const ALL_WELLS: readonly WellId[] = ['A', 'B', 'C'];

export type ApiAnalyte = {
	id: string;
	/** Matches the cartridge's `assayName` ("Cortisol - 6.1"). */
	assayPattern: RegExp;
	reportedWells: readonly WellId[];
};

export const ANALYTES: readonly ApiAnalyte[] = [
	// The first cortisol cartridges carry the assay in channel A only.
	{ id: 'cortisol', assayPattern: /^Cortisol/i, reportedWells: ['A'] }
];

/** The analyte a cartridge's assay belongs to, or null when the API reports none for it. */
export function analyteForAssay(assayName: string | null | undefined): ApiAnalyte | null {
	const name = (assayName ?? '').trim();
	return ANALYTES.find((a) => a.assayPattern.test(name)) ?? null;
}
