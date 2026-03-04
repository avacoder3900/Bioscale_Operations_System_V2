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
		sessionId: String, type: String,
		status: { type: String, enum: ['pending', 'passed', 'failed'] },
		completedAt: Date,
		results: [{ testType: String, passed: Boolean, notes: String, createdAt: Date }]
	},

	assignment: {
		type: String,
		customer: { _id: String, name: String },
		assignedAt: Date, assignedBy: operatorRef
	},

	status: { type: String, enum: ['draft', 'assembling', 'assembled', 'validating', 'validated', 'assigned', 'deployed', 'servicing', 'retired', 'voided'] },
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
spuSchema.index({ 'batch._id': 1, status: 1 });
spuSchema.index({ status: 1, assemblyStatus: 1 });
spuSchema.index({ 'assignment.customer._id': 1 });
spuSchema.index({ 'parts.lotNumber': 1 });
spuSchema.index({ 'parts.partNumber': 1 });
spuSchema.index({ createdBy: 1 });

applySacredMiddleware(spuSchema);

export const Spu = mongoose.models.Spu || mongoose.model('Spu', spuSchema, 'spus');
