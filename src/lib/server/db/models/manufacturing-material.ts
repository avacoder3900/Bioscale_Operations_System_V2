import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const manufacturingMaterialSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: String, unit: String, currentQuantity: { type: Number, default: 0 },
	recentTransactions: [{
		_id: { type: String, default: () => generateId() },
		transactionType: String, quantityChanged: Number,
		quantityBefore: Number, quantityAfter: Number,
		relatedBatchId: String, operatorId: String, notes: String, createdAt: Date
	}],
	updatedAt: Date
}, { timestamps: false });

export const ManufacturingMaterial = mongoose.models.ManufacturingMaterial || mongoose.model('ManufacturingMaterial', manufacturingMaterialSchema, 'manufacturing_materials');
