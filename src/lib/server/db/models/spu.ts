import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applySacredMiddleware } from '../middleware/sacred.js';

const operatorRef = { _id: String, username: String };
const correctionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	fieldPath: String, previousValue: Schema.Types.Mixed, correctedValue: Schema.Types.Mixed,
	reason: String, correctedBy: operatorRef, correctedAt: Date, approvedBy: operatorRef, approvedAt: Date
}, { _id: false });

const spuSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	udi: { type: String, required: true },
	barcode: { type: String },

	batch: { _id: String, batchNumber: String },

	parts: [{
		_id: { type: String, default: () => generateId() },
		partDefinitionId: String, partNumber: String, partName: String,
		lotNumber: String, serialNumber: String, scannedAt: Date,
		scannedBy: operatorRef, barcodeData: String,
		isReplaced: { type: Boolean, default: false },
		replacedBy: String, replaceReason: String
	}],

	assembly: {
		sessionId: String, workInstructionId: String, workInstructionVersion: Number,
		workInstructionTitle: String, startedAt: Date, completedAt: Date,
		operator: operatorRef, workstationId: String,
		stepRecords: [{
			_id: { type: String, default: () => generateId() },
			stepNumber: Number, stepTitle: String, scannedLotNumber: String, scannedPartNumber: String,
			completedAt: Date, completedBy: operatorRef,
			fieldRecords: [{
				_id: { type: String, default: () => generateId() },
				fieldName: String, fieldLabel: String, fieldValue: String,
				rawBarcodeData: String, capturedAt: Date, capturedBy: String
			}]
		}]
	},

	signature: {
		_id: { type: String, default: () => generateId() },
		userId: String, username: String, meaning: String,
		signedAt: Date, ipAddress: String, dataHash: String
	},

	particleLink: {
		particleSerial: String, particleDeviceId: String,
		linkedAt: Date, linkedBy: operatorRef,
		previousSpuId: String, unlinkReason: String
	},

	validation: {
		status: { type: String, enum: ['pending', 'passed', 'failed'], default: 'pending' },
		magnetometer: {
			status: { type: String, enum: ['pending', 'passed', 'failed'], default: 'pending' },
			sessionId: String, completedAt: Date, rawData: Schema.Types.Mixed,
			results: Schema.Types.Mixed, failureReasons: [String], criteriaUsed: Schema.Types.Mixed
		},
		thermocouple: {
			status: { type: String, enum: ['pending', 'passed', 'failed'], default: 'pending' },
			sessionId: String, completedAt: Date, rawData: Schema.Types.Mixed,
			results: Schema.Types.Mixed, failureReasons: [String], criteriaUsed: Schema.Types.Mixed
		},
		lux: {
			status: { type: String, enum: ['pending', 'passed', 'failed'], default: 'pending' },
			sessionId: String, completedAt: Date, rawData: Schema.Types.Mixed,
			results: Schema.Types.Mixed, failureReasons: [String], criteriaUsed: Schema.Types.Mixed
		},
		spectrophotometer: {
			status: { type: String, enum: ['pending', 'passed', 'failed'], default: 'pending' },
			sessionId: String, completedAt: Date, rawData: Schema.Types.Mixed,
			results: Schema.Types.Mixed, failureReasons: [String], criteriaUsed: Schema.Types.Mixed
		}
	},

	assignment: {
		type: String,
		customer: { _id: String, name: String },
		assignedAt: Date, assignedBy: operatorRef
	},

	status: { type: String, enum: ['draft', 'assembling', 'assembled', 'validating', 'validated', 'released-rnd', 'released-manufacturing', 'released-field', 'deployed', 'servicing', 'retired', 'voided'] },
	statusTransitions: [{
		_id: { type: String, default: () => generateId() },
		from: String,
		to: { type: String, required: true },
		changedBy: operatorRef,
		changedAt: { type: Date, default: () => new Date() },
		reason: String
	}],
	deviceState: String,
	assemblyStatus: { type: String, enum: ['created', 'in_progress', 'completed'] },
	qcStatus: { type: String, enum: ['pending', 'passed', 'failed'] },
	qcDocumentUrl: String,

	finalizedAt: Date,
	voidedAt: Date,
	voidReason: String,
	corrections: [correctionSchema],
	createdBy: String,
	owner: String,
	ownerNotes: String
}, { timestamps: true });

spuSchema.index({ udi: 1 }, { unique: true });
spuSchema.index({ barcode: 1 }, { sparse: true });
spuSchema.index({ 'batch._id': 1, status: 1 });
spuSchema.index({ status: 1, assemblyStatus: 1 });
spuSchema.index({ 'assignment.customer._id': 1 });
spuSchema.index({ 'parts.lotNumber': 1 });
spuSchema.index({ 'parts.partNumber': 1 });
spuSchema.index({ createdBy: 1 });

applySacredMiddleware(spuSchema);

export const Spu = mongoose.models.Spu || mongoose.model('Spu', spuSchema, 'spus');
