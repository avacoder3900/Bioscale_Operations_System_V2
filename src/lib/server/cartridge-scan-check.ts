/**
 * Batch cartridge scan checking.
 *
 * Operators scan a whole deck / seal batch without interruption — nothing is
 * validated while they scan. When they are done, the entire scan set is checked
 * here in one pass (one DB query for the whole set) and every unacceptable
 * barcode comes back flagged, so the operator fixes them all at once instead of
 * being stopped mid-run by each bad scan.
 */
import { CartridgeRecord } from '$lib/server/db';

export type ScanContext = 'wax-deck' | 'reagent-deck' | 'top-seal';

export interface ScanFlag {
	code:
		| 'duplicate'
		| 'over_capacity'
		| 'voided'
		| 'already_wax_filled'
		| 'already_reagent_filled'
		| 'already_sealed'
		| 'unknown'
		| 'not_accepted';
	message: string;
}

export interface ScanCheckResult {
	/** Scanned barcode, in the order it was scanned */
	barcode: string;
	/** Zero-based scan position — lines the result up with the deck/batch slot */
	position: number;
	ok: boolean;
	flags: ScanFlag[];
}

export interface ScanCheckOptions {
	/** Max slots for this surface (24 for a deck, 12 for a seal batch) */
	capacity?: number;
	/** Barcodes legitimately available to scan here (top sealing's accepted list) */
	allowedIds?: string[];
}

/**
 * Check a full scan set. Never throws on bad input — an unusable barcode simply
 * comes back flagged.
 */
export async function checkCartridgeScans(
	barcodes: string[],
	context: ScanContext,
	options: ScanCheckOptions = {}
): Promise<ScanCheckResult[]> {
	const { capacity, allowedIds } = options;

	const results: ScanCheckResult[] = barcodes.map((barcode, position) => ({
		barcode,
		position,
		ok: true,
		flags: []
	}));

	// --- Local checks: duplicates and capacity -------------------------------
	const firstSeen = new Map<string, number>();
	for (const r of results) {
		const prev = firstSeen.get(r.barcode);
		if (prev === undefined) {
			firstSeen.set(r.barcode, r.position);
		} else {
			r.flags.push({
				code: 'duplicate',
				message: `Already scanned at position ${prev + 1}`
			});
		}
		if (capacity != null && r.position >= capacity) {
			r.flags.push({
				code: 'over_capacity',
				message: `Beyond capacity — only ${capacity} slots available`
			});
		}
	}

	// --- Server checks: one query for every distinct barcode -----------------
	const uniqueIds = [...firstSeen.keys()];
	if (uniqueIds.length > 0) {
		const records = await CartridgeRecord.find({ _id: { $in: uniqueIds } })
			.select('_id currentPhase voidedAt waxFilling.recordedAt reagentFilling.recordedAt topSeal.recordedAt')
			.lean();

		const byId = new Map<string, any>();
		for (const rec of records as any[]) byId.set(String(rec._id), rec);

		const allowed = allowedIds ? new Set(allowedIds) : null;

		for (const r of results) {
			const rec = byId.get(r.barcode);

			if (allowed && !allowed.has(r.barcode)) {
				r.flags.push({ code: 'not_accepted', message: 'Not in the accepted list for this run' });
			}

			if (!rec) {
				// Deck loading upserts a stub for a first-time barcode, so an unknown
				// barcode is only a problem where the cartridge must already exist.
				if (context === 'top-seal') {
					r.flags.push({ code: 'unknown', message: 'No cartridge record found' });
				}
				continue;
			}

			if (rec.currentPhase === 'voided' || rec.voidedAt) {
				r.flags.push({ code: 'voided', message: 'Cartridge is voided' });
			}

			if (context === 'wax-deck' && rec.waxFilling?.recordedAt) {
				r.flags.push({ code: 'already_wax_filled', message: 'Already wax filled' });
			}

			if (context === 'reagent-deck' && rec.reagentFilling?.recordedAt) {
				r.flags.push({ code: 'already_reagent_filled', message: 'Already reagent filled' });
			}

			if (context === 'top-seal' && rec.topSeal?.recordedAt) {
				r.flags.push({ code: 'already_sealed', message: 'Already top sealed' });
			}
		}
	}

	for (const r of results) r.ok = r.flags.length === 0;
	return results;
}
