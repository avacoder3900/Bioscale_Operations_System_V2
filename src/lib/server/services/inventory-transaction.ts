import { InventoryTransaction, PartDefinition } from '$lib/server/db/models/index.js';
import { generateId } from '$lib/server/db/utils.js';
import { notifyLowInventory, shouldWarnLowInventory } from '$lib/server/notifications';

// Cache partDefinitionId lookups by partNumber (stable across requests in same process)
const partNumberCache = new Map<string, string | null>();
// In-flight lookups, so two callers resolving the same part in the same tick
// (a bucket scan-in debits its shell and its label in parallel) share one query
// instead of both missing the cache.
const partNumberInFlight = new Map<string, Promise<string | null>>();

/**
 * Look up a PartDefinition _id by partNumber (e.g. 'PT-CT-104').
 * Caches results to avoid repeated DB queries.
 */
export async function resolvePartId(partNumber: string): Promise<string | null> {
	if (partNumberCache.has(partNumber)) return partNumberCache.get(partNumber)!;
	const pending = partNumberInFlight.get(partNumber);
	if (pending) return pending;
	const lookup = (async () => {
		try {
			const part = await PartDefinition.findOne({ partNumber }).select('_id').lean() as any;
			const id = part ? String(part._id) : null;
			partNumberCache.set(partNumber, id);
			return id;
		} finally {
			partNumberInFlight.delete(partNumber);
		}
	})();
	partNumberInFlight.set(partNumber, lookup);
	return lookup;
}

export interface RecordTransactionParams {
	transactionType: 'receipt' | 'consumption' | 'creation' | 'scrap' | 'adjustment';
	partDefinitionId?: string;
	lotId?: string;
	cartridgeRecordId?: string;
	spuId?: string;
	quantity: number;
	manufacturingStep?: 'cut_thermoseal' | 'laser_cut' | 'backing' | 'wax_filling' | 'reagent_filling' | 'top_seal' | 'cut_top_seal' | 'storage' | 'qa_qc' | 'scrap';
	manufacturingRunId?: string;
	operatorId?: string;
	operatorUsername?: string;
	notes?: string;
	scrapReason?: string;
	scrapCategory?: 'dimensional' | 'contamination' | 'seal_failure' | 'wax_defect' | 'reagent_defect' | 'other';
	photoUrl?: string;
}

/**
 * Record an inventory transaction and update part inventory count.
 * All transactions are immutable (append-only).
 */
export async function recordTransaction(params: RecordTransactionParams): Promise<string> {
	const now = new Date();
	let previousQuantity = 0;
	let newQuantity = 0;

	// Update part inventory count if partDefinitionId is provided
	if (params.partDefinitionId) {
		const delta =
			params.transactionType === 'consumption' || params.transactionType === 'scrap'
				? -Math.abs(params.quantity)
				: params.transactionType === 'creation' || params.transactionType === 'receipt'
					? Math.abs(params.quantity)
					: params.quantity; // adjustment: signed

		// $inc in one round trip, NOT read-then-$set (fixed 2026-09-25). The old
		// read-compute-$set lost updates: two operators scanning carts into two
		// buckets at the same moment both debited PT-CT-104 from the same stale
		// read and the second write clobbered the first, so the shell count
		// drifted high with no trace. The post-write doc gives newQuantity, and
		// previousQuantity is derived from it rather than read separately.
		const part = await PartDefinition.findOneAndUpdate(
			{ _id: params.partDefinitionId },
			{ $inc: { inventoryCount: delta } },
			{ new: true, lean: true }
		) as any;
		if (part) {
			newQuantity = Number(part.inventoryCount ?? 0);
			previousQuantity = newQuantity - delta;
		}

		// KB2-13 supply loop: a stock decrement re-checks the part-reorder rule +
		// any part_stock standing targets for THIS part. Coalesced per part (see
		// requestSupplyCheckForPart) so a burst of scans costs one check, taken
		// after the last decrement, instead of one per scan competing with the
		// scans themselves for the connection pool. Lazy import — the supply
		// autopilot must never throw into (or slow) the transaction path.
		if (part && delta < 0) {
			const partId = String(params.partDefinitionId);
			import('$lib/server/kanban/standing')
				.then(({ requestSupplyCheckForPart }) => requestSupplyCheckForPart(partId))
				.catch((e) => console.error('[inventory-transaction] supply check failed:', e));
		}

		// Low inventory check — only fire on the transition into low state
		if (params.transactionType === 'consumption' || params.transactionType === 'scrap') {
			const minOrder = part?.minimumOrderQty;
			if (minOrder && await shouldWarnLowInventory({ inventoryCount: newQuantity, minimumOrderQty: minOrder })) {
				const wasAboveThreshold = !(await shouldWarnLowInventory({ inventoryCount: previousQuantity, minimumOrderQty: minOrder }));
				if (wasAboveThreshold) {
					await notifyLowInventory({
						_id: String(params.partDefinitionId),
						partNumber: part.partNumber,
						name: part.name,
						inventoryCount: newQuantity,
						minimumOrderQty: minOrder,
						unitOfMeasure: part.unitOfMeasure
					});
				}
			}
		}
	}

	const txId = generateId();
	await InventoryTransaction.create({
		_id: txId,
		transactionType: params.transactionType,
		partDefinitionId: params.partDefinitionId,
		lotId: params.lotId,
		cartridgeRecordId: params.cartridgeRecordId,
		spuId: params.spuId,
		quantity: params.quantity,
		previousQuantity,
		newQuantity,
		manufacturingStep: params.manufacturingStep,
		manufacturingRunId: params.manufacturingRunId,
		operatorId: params.operatorId,
		operatorUsername: params.operatorUsername,
		performedBy: params.operatorUsername ?? params.operatorId,
		performedAt: now,
		notes: params.notes,
		reason: params.notes,
		scrapReason: params.scrapReason,
		scrapCategory: params.scrapCategory,
		photoUrl: params.photoUrl
	});

	return txId;
}

/**
 * Record multiple transactions in bulk (e.g., for batch operations).
 */
export async function recordTransactionBatch(paramsList: RecordTransactionParams[]): Promise<string[]> {
	const ids: string[] = [];
	for (const params of paramsList) {
		const id = await recordTransaction(params);
		ids.push(id);
	}
	return ids;
}
