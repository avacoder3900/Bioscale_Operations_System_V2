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
	skuCode: String,
	duration: Number,
	// Legacy: BCODE (uppercase) holds `{ deviceParams, code: [...] }`. Declared
	// here so Mongoose preserves it on write — creation paths populate it via
	// $lib/server/assay-legacy-shape.ts. The old lowercase `bcode` Buffer
	// field below is orphaned (no writer, no legacy doc has it) and will be
	// removed in a follow-up cleanup.
	BCODE: Schema.Types.Mixed,
	hidden: { type: Boolean, default: false },
	protected: { type: Boolean, default: false },
	bcode: Schema.Types.Buffer,
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
		previousBcode: Schema.Types.Buffer, previousBcodeLength: Number, previousChecksum: Number,
		previousDuration: Number, previousMetadata: Schema.Types.Mixed,
		changedBy: operatorRef, changedAt: Date, changeNotes: String
	}],

	lockedAt: Date,
	lockedBy: operatorRef,
	corrections: [correctionSchema],
	metadata: Schema.Types.Mixed
}, { timestamps: true });

// skuCode is indexed but not unique: the 238 legacy docs all have null/absent
// skuCode, so enforcing uniqueness here would block every write. Uniqueness
// should be reintroduced as a partial index after legacy docs are backfilled.
assayDefinitionSchema.index({ skuCode: 1 });
assayDefinitionSchema.index({ isActive: 1 });
assayDefinitionSchema.index({ name: 1 });

applySacredMiddleware(assayDefinitionSchema);

export const AssayDefinition = mongoose.models.AssayDefinition || mongoose.model('AssayDefinition', assayDefinitionSchema, 'assay_definitions');
