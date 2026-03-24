import { InventoryTransaction, PartDefinition } from '$lib/server/db/models/index.js';
import { generateId } from '$lib/server/db/utils.js';

// Cache partDefinitionId lookups by partNumber (stable across requests in same process)
const partNumberCache = new Map<string, string | null>();

/**
 * Look up a PartDefinition _id by partNumber (e.g. 'PT-CT-104').
 * Caches results to avoid repeated DB queries.
 */
export async function resolvePartId(partNumber: string): Promise<string | null> {
	if (partNumberCache.has(partNumber)) return partNumberCache.get(partNumber)!;
	const part = await PartDefinition.findOne({ partNumber }).select('_id').lean() as any;
	const id = part ? String(part._id) : null;
	partNumberCache.set(partNumber, id);
	return id;
}

export interface RecordTransactionParams {
	transactionType: 'receipt' | 'consumption' | 'creation' | 'scrap' | 'adjustment';
	partDefinitionId?: string;
	lotId?: string;
	cartridgeRecordId?: string;
	quantity: number;
	manufacturingStep?: 'cut_thermoseal' | 'laser_cut' | 'backing' | 'wax_filling' | 'reagent_filling' | 'top_seal' | 'storage' | 'qa_qc' | 'scrap';
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
		const part = await PartDefinition.findById(params.partDefinitionId).lean() as any;
		previousQuantity = part?.inventoryCount ?? 0;

		if (params.transactionType === 'consumption' || params.transactionType === 'scrap') {
			newQuantity = previousQuantity - Math.abs(params.quantity);
		} else if (params.transactionType === 'creation' || params.transactionType === 'receipt') {
			newQuantity = previousQuantity + Math.abs(params.quantity);
		} else {
			// adjustment: quantity can be positive or negative
			newQuantity = previousQuantity + params.quantity;
		}

		await PartDefinition.updateOne(
			{ _id: params.partDefinitionId },
			{ $set: { inventoryCount: newQuantity } }
		);
	}

	const txId = generateId();
	await InventoryTransaction.create({
		_id: txId,
		transactionType: params.transactionType,
		partDefinitionId: params.partDefinitionId,
		lotId: params.lotId,
		cartridgeRecordId: params.cartridgeRecordId,
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
