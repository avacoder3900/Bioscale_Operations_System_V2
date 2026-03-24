import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const manufacturingMaterialTransactionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	materialId: String, transactionType: String,
	quantityChanged: Number, quantityBefore: Number, quantityAfter: Number,
	relatedBatchId: String, operatorId: String, notes: String,
	createdAt: { type: Date, default: Date.now }
}, { timestamps: false });

applyImmutableMiddleware(manufacturingMaterialTransactionSchema);

export const ManufacturingMaterialTransaction = mongoose.models.ManufacturingMaterialTransaction || mongoose.model('ManufacturingMaterialTransaction', manufacturingMaterialTransactionSchema, 'manufacturing_material_transactions');
