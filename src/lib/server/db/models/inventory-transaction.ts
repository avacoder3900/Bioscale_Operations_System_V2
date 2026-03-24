import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const inventoryTransactionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	partDefinitionId: String, bomItemId: String,
	assemblySessionId: String, assemblyStepRecordId: String,
	transactionType: {
		type: String,
		enum: ['deduction', 'retraction', 'adjustment', 'receipt', 'consumption', 'creation', 'scrap']
	},
	quantity: Number, previousQuantity: Number, newQuantity: Number,
	reason: String, performedBy: String, performedAt: Date,
	retractedBy: String, retractedAt: Date, retractionReason: String,

	// Traceability fields (PRD-3)
	lotId: String,
	cartridgeRecordId: String,
	manufacturingStep: {
		type: String,
		enum: ['cut_thermoseal', 'laser_cut', 'backing', 'wax_filling', 'reagent_filling',
			'top_seal', 'storage', 'qa_qc', 'scrap']
	},
	manufacturingRunId: String,
	operatorId: String,
	operatorUsername: String,
	notes: String,
	scrapReason: String,
	scrapCategory: {
		type: String,
		enum: ['dimensional', 'contamination', 'seal_failure', 'wax_defect', 'reagent_defect', 'other']
	},
	photoUrl: String
}, { timestamps: false });

inventoryTransactionSchema.index({ partDefinitionId: 1, performedAt: -1 });
inventoryTransactionSchema.index({ lotId: 1 });
inventoryTransactionSchema.index({ cartridgeRecordId: 1 });
inventoryTransactionSchema.index({ manufacturingStep: 1 });
inventoryTransactionSchema.index({ manufacturingRunId: 1 });
inventoryTransactionSchema.index({ transactionType: 1, performedAt: -1 });

applyImmutableMiddleware(inventoryTransactionSchema);

export const InventoryTransaction = mongoose.models.InventoryTransaction || mongoose.model('InventoryTransaction', inventoryTransactionSchema, 'inventory_transactions');
