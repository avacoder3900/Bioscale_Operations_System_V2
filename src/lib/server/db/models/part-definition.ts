import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const partDefinitionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	partNumber: String, name: String, description: String, category: String,
	supplier: String, manufacturer: String, vendorPartNumber: String,
	unitCost: String, unitOfMeasure: String, leadTimeDays: Number,
	minimumOrderQty: Number, hazardClass: String, certifications: Schema.Types.Mixed,
	expirationDate: Date, msdsFileId: String,
	inspectionPathway: String, scanRequired: Boolean,
	sortOrder: { type: Number, default: 0 },
	isActive: { type: Boolean, default: true },
	sampleSize: { type: Number, default: 0 },
	percentAccepted: { type: Number, default: 100 },
	createdBy: String
}, { timestamps: true });

partDefinitionSchema.index({ partNumber: 1 }, { unique: true });

export const PartDefinition = mongoose.models.PartDefinition || mongoose.model('PartDefinition', partDefinitionSchema, 'part_definitions');
