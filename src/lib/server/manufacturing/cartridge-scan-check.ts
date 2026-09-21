import { CartridgeRecord } from '$lib/server/db';
import { isReagentEligible } from '$lib/shared/cartridge-wax-status';

export type ScanContext = 'wax' | 'reagent';

export type ScanVerdict = {
	barcode: string;
	ok: boolean;
	/** True when no CartridgeRecord exists yet (wax context creates it on commit). */
	isNew: boolean;
	/** Existing status, when the record was already present. */
	phase: string | null;
	/** Operator-facing reason, only set when ok === false. */
	error?: string;
};

/**
 * Batch equivalent of `GET /api/dev/validate-equipment?type=cartridge`.
 *
 * SCAN-THEN-CHECK: the deck grid no longer validates each scan over the wire as
 * the operator scans. Scans are accepted locally and the whole deck is checked
 * in one pass at the deferred boundary (deck full, or the next action). That
 * turns N round-trips into a single `$in` query.
 *
 * The per-barcode verdict rules below are deliberately identical to the
 * single-scan endpoint's cartridge branch so the deferred check can never
 * disagree with the eager one. If you change a rule here, change it there too.
 */
export async function checkCartridgeScans(
	barcodes: string[],
	context: ScanContext = 'wax'
): Promise<ScanVerdict[]> {
	const trimmed = barcodes.map((b) => (b ?? '').trim());

	// Duplicates inside the submitted batch. Deferred scanning means the batch
	// itself can carry a repeat that no single-scan call would ever have seen.
	// First occurrence stays eligible; later ones are rejected against it.
	const firstSeen = new Map<string, number>();
	trimmed.forEach((b, i) => {
		if (b && !firstSeen.has(b)) firstSeen.set(b, i);
	});

	const unique = [...firstSeen.keys()];
	const found = unique.length
		? await CartridgeRecord.find({ _id: { $in: unique } })
				.select('_id status')
				.lean()
		: [];
	const byId = new Map(found.map((c) => [String((c as any)._id), c as any]));

	return trimmed.map((barcode, i) => {
		if (!barcode) {
			return { barcode, ok: false, isNew: false, phase: null, error: 'Empty barcode' };
		}

		const first = firstSeen.get(barcode);
		if (first !== undefined && first !== i) {
			return {
				barcode,
				ok: false,
				isNew: false,
				phase: null,
				error: `Cartridge "${barcode}" is scanned more than once in this batch (first at position ${first + 1}).`
			};
		}

		const cart = byId.get(barcode);
		const phase = (cart?.status ?? null) as string | null;

		if (context === 'reagent') {
			if (!cart) {
				return {
					barcode,
					ok: false,
					isNew: true,
					phase: null,
					error: `Cartridge "${barcode}" not found. It must go through wax filling first.`
				};
			}
			// WAX-SIMPLIFY-3: same helper as the reagent-filling startRun gate.
			const gate = isReagentEligible(phase as any);
			if (!gate.ok) {
				return {
					barcode,
					ok: false,
					isNew: false,
					phase,
					error: `Cartridge "${barcode}" can't be reagent-filled — ${gate.hint}.`
				};
			}
			return { barcode, ok: true, isNew: false, phase };
		}

		// Wax filling context: cartridge should be new, or in backing/voided phase.
		if (cart && phase && phase !== 'backing' && phase !== 'voided') {
			return {
				barcode,
				ok: false,
				isNew: false,
				phase,
				error: `Cartridge "${barcode}" already exists in phase "${phase}". It cannot be re-scanned.`
			};
		}
		return { barcode, ok: true, isNew: !cart, phase };
	});
}
