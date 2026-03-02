import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const inventoryTransactionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	partDefinitionId: String, bomItemId: String,
	assemblySessionId: String, assemblyStepRecordId: String,
	transactionType: { type: String, enum: ['deduction', 'retraction', 'adjustment', 'receipt'] },
	quantity: Number, previousQuantity: Number, newQuantity: Number,
	reason: String, performedBy: String, performedAt: Date,
	retractedBy: String, retractedAt: Date, retractionReason: String
}, { timestamps: false });

applyImmutableMiddleware(inventoryTransactionSchema);

export const InventoryTransaction = mongoose.models.InventoryTransaction || mongoose.model('InventoryTransaction', inventoryTransactionSchema, 'inventory_transactions');
