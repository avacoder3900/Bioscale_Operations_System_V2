/**
 * SPU kit withdrawal — deduct the full standard parts kit for one SPU in a
 * single operation.
 *
 * Assembly scans only deduct the handful of parts that carry a scannable
 * barcode (-1 per scan), so screws, washers, magnets and labels never leave
 * the books. This withdraws the complete per-unit kit as curated in
 * SPU_COMPONENT_PARTS (WIMF-SPU-01 v18) instead.
 *
 * Parts that are not yet in part_definitions (e.g. PT-SPU-104, the 40-tooth
 * pulley) cannot be deducted. Those are skipped rather than failing the whole
 * withdrawal, and the curated note explaining why is carried through to the
 * operator so the gap is visible at the moment of withdrawal.
 */

import { AuditLog, InventoryTransaction } from '$lib/server/db/models/index.js';
import { generateId } from '$lib/server/db/utils.js';
import { SPU_COMPONENT_PARTS } from './spu-component-parts.js';
import { recordTransaction } from './inventory-transaction.js';
import { resolvePartRef } from './inventory-resolve.js';

/** Marks the transactions this flow writes so repeat withdrawals are detectable. */
export const KIT_WITHDRAWAL_PREFIX = 'SPU kit withdrawal';

export interface KitLine {
	partNumber: string;
	name: string;
	/** Total per one SPU, summed across every component the part appears in. */
	quantity: number;
	/** Component names this part is used in, for operator context. */
	components: string[];
	/** Curated WI notes — surfaced verbatim, especially for unresolvable parts. */
	notes: string[];
	partDefinitionId: string | null;
	currentStock: number | null;
	/** False when the part number has no active PartDefinition — cannot deduct. */
	resolved: boolean;
	/** True when stock on hand is below the quantity this kit needs. */
	short: boolean;
	/**
	 * Set when the part is deliberately not withdrawn (antennas, aluminum tape
	 * pending its mm figure). Distinct from `resolved: false`, which means the
	 * part number simply does not exist in inventory.
	 */
	excludedReason: string | null;
}

/**
 * Flatten the component map into one line per distinct part number.
 *
 * Parts recur across components (PT-SPU-030 appears in several), so quantities
 * are summed — the kit is what one SPU consumes in total, not per component.
 */
export function buildSpuKit(): Omit<
	KitLine,
	'partDefinitionId' | 'currentStock' | 'resolved' | 'short'
>[] {
	const byPart = new Map<
		string,
		{
			partNumber: string;
			name: string;
			quantity: number;
			components: string[];
			notes: string[];
			excludedReason: string | null;
		}
	>();

	for (const component of SPU_COMPONENT_PARTS) {
		for (const part of component.parts) {
			const existing = byPart.get(part.partNumber);
			if (existing) {
				existing.quantity += part.quantityPerUnit;
				if (!existing.components.includes(component.name)) existing.components.push(component.name);
				if (part.note && !existing.notes.includes(part.note)) existing.notes.push(part.note);
				// A part excluded in any component is excluded for the whole kit —
				// withdrawing it "only for the other component" would be arbitrary.
				if (part.kitExclusion && !existing.excludedReason) existing.excludedReason = part.kitExclusion;
			} else {
				byPart.set(part.partNumber, {
					partNumber: part.partNumber,
					name: part.name,
					quantity: part.quantityPerUnit,
					components: [component.name],
					notes: part.note ? [part.note] : [],
					excludedReason: part.kitExclusion ?? null
				});
			}
		}
	}

	// Parts carrying a kitExclusion are not in the kit at all. They stay in
	// SPU_COMPONENT_PARTS because that map doubles as the agent reassembly
	// knowledge base ("what lives in the antennas component?"), but they are
	// dropped here so the withdrawal never lists, counts, or reports them --
	// an operator reading the withdrawal should see only what it withdraws.
	return [...byPart.values()]
		.filter((p) => !p.excludedReason)
		.sort((a, b) => a.partNumber.localeCompare(b.partNumber));
}

/**
 * Resolve the kit against live inventory: what each part is, how much is on
 * hand, and which lines cannot be deducted at all.
 *
 * Pure read — safe to call from a load function to render the confirmation
 * table before the operator commits.
 */
export async function previewSpuKit(): Promise<{
	lines: KitLine[];
	totalParts: number;
	totalUnits: number;
	deductedParts: number;
	deductedUnits: number;
	unresolved: KitLine[];
	excluded: KitLine[];
	shortages: KitLine[];
}> {
	const kit = buildSpuKit();

	const lines: KitLine[] = [];
	for (const line of kit) {
		// An excluded line is never deducted, so its stock is not worth a lookup.
		const def = line.excludedReason ? null : await resolvePartRef(line.partNumber);
		lines.push({
			...line,
			partDefinitionId: def ? String(def._id) : null,
			currentStock: def ? (def.inventoryCount ?? 0) : null,
			resolved: Boolean(def),
			short: def ? (def.inventoryCount ?? 0) < line.quantity : false
		});
	}

	const deducted = lines.filter((l) => l.resolved && !l.excludedReason);

	return {
		lines,
		totalParts: lines.length,
		totalUnits: lines.reduce((sum, l) => sum + l.quantity, 0),
		deductedParts: deducted.length,
		deductedUnits: deducted.reduce((sum, l) => sum + l.quantity, 0),
		unresolved: lines.filter((l) => !l.resolved && !l.excludedReason),
		excluded: lines.filter((l) => l.excludedReason),
		shortages: deducted.filter((l) => l.short)
	};
}

/** SPU ids that already had a kit withdrawn, so the UI can warn on repeats. */
export async function spuIdsWithKitWithdrawal(): Promise<string[]> {
	const ids = await InventoryTransaction.distinct('spuId', {
		transactionType: 'consumption',
		notes: new RegExp(`^${KIT_WITHDRAWAL_PREFIX}`)
	});
	return (ids as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export interface WithdrawResult {
	withdrawn: Array<{
		transactionId: string;
		partNumber: string;
		name: string;
		quantity: number;
		previousCount: number;
		newCount: number;
	}>;
	/**
	 * Lines that were not deducted. `kind` keeps a deliberate policy decision
	 * distinct from a data problem: 'excluded' means the kit is defined not to
	 * withdraw this part, 'unresolved' means it should have been withdrawn but
	 * there is no active part definition to deduct from. Collapsing the two
	 * makes every operator decision look like a failure in the result panel.
	 */
	skipped: Array<{
		kind: 'excluded' | 'unresolved';
		partNumber: string;
		name: string;
		quantity: number;
		reason: string;
		notes: string[];
	}>;
}

/**
 * Apply the kit withdrawal for one SPU.
 *
 * Every resolvable line is deducted; unresolvable ones are skipped and
 * returned with their curated notes. Stock is allowed to go short (a shortage
 * means the physical count is behind, not that the part wasn't used) — the
 * caller surfaces both lists to the operator.
 */
export async function withdrawSpuKit(params: {
	spuId: string;
	spuLabel: string;
	operatorUsername: string;
	operatorId?: string;
}): Promise<WithdrawResult> {
	const { lines } = await previewSpuKit();
	const result: WithdrawResult = { withdrawn: [], skipped: [] };

	for (const line of lines) {
		if (line.excludedReason) {
			result.skipped.push({
				kind: 'excluded',
				partNumber: line.partNumber,
				name: line.name,
				quantity: line.quantity,
				reason: line.excludedReason,
				notes: line.notes
			});
			continue;
		}

		if (!line.resolved || !line.partDefinitionId) {
			result.skipped.push({
				kind: 'unresolved',
				partNumber: line.partNumber,
				name: line.name,
				quantity: line.quantity,
				reason: 'Not in the inventory system — no active part definition to deduct from',
				notes: line.notes
			});
			continue;
		}

		const transactionId = await recordTransaction({
			transactionType: 'consumption',
			partDefinitionId: line.partDefinitionId,
			spuId: params.spuId,
			quantity: line.quantity,
			operatorId: params.operatorId,
			operatorUsername: params.operatorUsername,
			notes: `${KIT_WITHDRAWAL_PREFIX} for SPU ${params.spuLabel}: ${line.name}`
		});

		// Read the before/after balance off the ledger row itself rather than
		// re-reading the part and inferring `previous = new + quantity`. That
		// inference assumes nothing else moved the part between the decrement
		// and the re-read, which is exactly the assumption this feature exists
		// to verify. recordTransaction() captures both values at the moment it
		// applies the change, so the row is the authoritative record.
		const ledger = (await InventoryTransaction.findById(transactionId)
			.select('previousQuantity newQuantity')
			.lean()) as { previousQuantity?: number; newQuantity?: number } | null;

		result.withdrawn.push({
			transactionId,
			partNumber: line.partNumber,
			name: line.name,
			quantity: line.quantity,
			previousCount: ledger?.previousQuantity ?? 0,
			newCount: ledger?.newQuantity ?? 0
		});
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'inventory_transactions',
		recordId: params.spuId,
		action: 'INSERT',
		newData: {
			operation: 'spu_kit_withdrawal',
			spu: params.spuLabel,
			withdrawn: result.withdrawn.map((w) => ({ partNumber: w.partNumber, quantity: w.quantity })),
			skipped: result.skipped.map((s) => ({ partNumber: s.partNumber, quantity: s.quantity, reason: s.reason }))
		},
		changedBy: params.operatorUsername,
		changedAt: new Date()
	});

	return result;
}
