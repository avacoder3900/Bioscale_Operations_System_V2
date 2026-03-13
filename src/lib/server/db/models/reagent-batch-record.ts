import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applySacredMiddleware } from '../middleware/sacred.js';

const operatorRef = { _id: String, username: String };
const correctionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	fieldPath: String, previousValue: Schema.Types.Mixed, correctedValue: Schema.Types.Mixed,
	reason: String, correctedBy: operatorRef, correctedAt: Date, approvedBy: operatorRef, approvedAt: Date
}, { _id: false });

const reagentBatchRecordSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	runNumber: String,
	robot: { _id: String, name: String, side: String },
	assayType: { _id: String, name: String, skuCode: String },
	operator: operatorRef,
	deckId: String,

	tubeRecords: [{
		wellPosition: Number, reagentName: String, sourceLotId: String,
		transferTubeId: String, preparedAt: Date
	}],

	setupTimestamp: Date, runStartTime: Date, runEndTime: Date,
	// status stores the current UI workflow stage or terminal state
	status: {
		type: String,
		enum: [
			// Legacy values (keep for existing data)
			'setup', 'running', 'completed', 'aborted', 'voided',
			// Full workflow stages
			'Setup', 'Loading', 'Running', 'Inspection', 'Top Sealing', 'Storage',
			// Terminal states (PascalCase)
			'Completed', 'Aborted', 'Cancelled'
		]
	},
	abortReason: String, abortPhotoUrl: String,

	cartridgesFilled: [{
		cartridgeId: String, deckPosition: Number,
		inspectionStatus: { type: String, enum: ['Accepted', 'Rejected', 'Pending', 'QA/QC'] },
		inspectionReason: String, inspectedBy: operatorRef, inspectedAt: Date,
		topSealBatchId: String, storageLocation: String, storedAt: Date
	}],
	cartridgeCount: Number,

	// Top seal batches (supports multiple batches per run)
	sealBatches: [{
		_id: { type: String, default: () => generateId() },
		topSealLotId: String, operator: operatorRef,
		firstScanTime: Date, completionTime: Date, durationSeconds: Number,
		cartridgeIds: [String], status: { type: String, default: 'in_progress' }
	}],

	// Legacy single topSeal for backward compat
	topSeal: {
		_id: { type: String, default: () => generateId() },
		topSealLotId: String, operator: operatorRef,
		firstScanTime: Date, completionTime: Date, durationSeconds: Number,
		cartridgeCount: Number, status: String
	},

	qcRelease: {
		shippingLotId: String,
		qaqcCartridgeIds: [String],
		testResult: { type: String, enum: ['pass', 'fail', 'pending', 'testing'] },
		testedBy: operatorRef, testedAt: Date, notes: String,
		createdAt: Date
	},

	finalizedAt: Date, voidedAt: Date, voidReason: String,
	corrections: [correctionSchema]
}, { timestamps: true });

reagentBatchRecordSchema.index({ 'assayType._id': 1, status: 1 });
reagentBatchRecordSchema.index({ 'operator._id': 1 });
reagentBatchRecordSchema.index({ 'robot._id': 1 });
reagentBatchRecordSchema.index({ status: 1, createdAt: -1 });
reagentBatchRecordSchema.index({ 'cartridgesFilled.cartridgeId': 1 });

applySacredMiddleware(reagentBatchRecordSchema);

export const ReagentBatchRecord = mongoose.models.ReagentBatchRecord || mongoose.model('ReagentBatchRecord', reagentBatchRecordSchema, 'reagent_batch_records');
