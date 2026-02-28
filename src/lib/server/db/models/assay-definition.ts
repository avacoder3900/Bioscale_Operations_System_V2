import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applySacredMiddleware } from '../middleware/sacred.js';

const operatorRef = { _id: String, username: String };
const correctionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	fieldPath: String, previousValue: Schema.Types.Mixed, correctedValue: Schema.Types.Mixed,
	reason: String, correctedBy: operatorRef, correctedAt: Date, approvedBy: operatorRef, approvedAt: Date
}, { _id: false });

const assayDefinitionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	assayId: String,
	name: { type: String, required: true },
	description: String,
	skuCode: { type: String, required: true },
	duration: Number,
	bcode: Buffer,
	bcodeLength: Number,
	checksum: Number,
	isActive: { type: Boolean, default: true },
	shelfLifeDays: Number,
	bomCostOverride: String,
	useSingleCost: { type: Boolean, default: false },

	reagents: [{
		_id: { type: String, default: () => generateId() },
		wellPosition: Number, reagentName: String, unitCost: String,
		volumeMicroliters: Number, unit: String, classification: String,
		hasBreakdown: { type: Boolean, default: false }, sortOrder: Number,
		isActive: { type: Boolean, default: true },
		subComponents: [{
			_id: { type: String, default: () => generateId() },
			name: String, unitCost: String, unit: String,
			volumeMicroliters: Number, classification: String, sortOrder: Number
		}]
	}],

	versionHistory: [{
		version: Number, previousName: String, previousDescription: String,
		previousBcode: Buffer, previousBcodeLength: Number, previousChecksum: Number,
		previousDuration: Number, previousMetadata: Schema.Types.Mixed,
		changedBy: operatorRef, changedAt: Date, changeNotes: String
	}],

	lockedAt: Date,
	lockedBy: operatorRef,
	corrections: [correctionSchema],
	metadata: Schema.Types.Mixed
}, { timestamps: true });

assayDefinitionSchema.index({ skuCode: 1 }, { unique: true });
assayDefinitionSchema.index({ isActive: 1 });
assayDefinitionSchema.index({ name: 1 });

applySacredMiddleware(assayDefinitionSchema);

export const AssayDefinition = mongoose.models.AssayDefinition || mongoose.model('AssayDefinition', assayDefinitionSchema, 'assay_definitions');
