import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const bomItemSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	bomType: { type: String, enum: ['spu', 'cartridge'], default: 'spu' },
	partNumber: String, name: String, description: String, category: String,
	quantityPerUnit: Number, unitOfMeasure: String,
	supplier: String, manufacturer: String, vendorPartNumber: String,
	unitCost: String, leadTimeDays: Number, minimumOrderQty: Number,
	certifications: Schema.Types.Mixed, expirationDate: Date,
	msdsFileId: String, hazardClass: String,
	inventoryCount: Number, minimumStockLevel: { type: Number, default: 0 },
	isActive: { type: Boolean, default: true }, boxRowIndex: Number,
	versionHistory: [{
		version: Number, changeType: { type: String, enum: ['create', 'update', 'delete'] },
		previousValues: Schema.Types.Mixed, newValues: Schema.Types.Mixed,
		changedBy: String, changedAt: Date, changeReason: String
	}],
	partLinks: [{
		_id: { type: String, default: () => generateId() },
		partDefinitionId: String, partNumber: String, linkType: String,
		notes: String, createdBy: String, createdAt: Date
	}],
	createdBy: String
}, { timestamps: true });

export const BomItem = mongoose.models.BomItem || mongoose.model('BomItem', bomItemSchema, 'bom_items');
