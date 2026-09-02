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

	// Collapsed lifecycle (SPU-INV-07): draft → assembling → validating →
	// released ⇄ servicing → retired. The vocabulary + legal-transition table
	// live in src/lib/server/spu-status.ts — keep this enum in sync with it.
	// NOTE: updateOne skips enum validators; app code enforces via that module.
	status: { type: String, enum: ['draft', 'assembling', 'validating', 'released', 'servicing', 'retired'] },
	// Physical/organizational location, not lifecycle ("R&D" etc.) — what the
	// old released-rnd status encoded. Free-form for now.
	location: String,
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

	// File attachments stored inline (small CSVs, e.g. thermocouple readings).
	attachments: [{
		_id: { type: String, default: () => generateId() },
		kind: { type: String, default: 'thermocouple_csv' },
		fileName: String,
		mimeType: { type: String, default: 'text/csv' },
		fileSize: Number,
		rowCount: Number,
		content: String,
		sessionId: String,
		uploadedAt: { type: Date, default: () => new Date() },
		uploadedBy: operatorRef
	}],

	// Servicing lifecycle — each service event is numbered (cycle 1, 2, 3…).
	// A device sent for service gets an 'open' record; on return it becomes
	// 'returned' with the fix, and validationResetAt is stamped.
	serviceRecords: [{
		_id: { type: String, default: () => generateId() },
		cycle: Number,
		issue: String,
		initialTestPlan: String,
		fix: String,
		status: { type: String, enum: ['open', 'returned'], default: 'open' },
		openedBy: operatorRef, openedAt: { type: Date, default: () => new Date() },
		returnedBy: operatorRef, returnedAt: Date
	}],
	// Free-form device journal — append-only diary entries that carry the unit's
	// story (context the structured fields can't hold). Never edited or deleted
	// from the UI; corrections are new entries.
	journal: [{
		_id: { type: String, default: () => generateId() },
		text: { type: String, required: true },
		createdBy: operatorRef,
		createdAt: { type: Date, default: () => new Date() }
	}],

	// Validations completed before this instant don't count toward the current
	// N/3 (set when a serviced device is returned). Prior records are preserved.
	validationResetAt: Date,

	finalizedAt: Date,
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
