import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applySacredMiddleware } from '../middleware/sacred.js';

const operatorRef = { _id: String, username: String };
const correctionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	fieldPath: String,
	previousValue: Schema.Types.Mixed,
	correctedValue: Schema.Types.Mixed,
	reason: String,
	correctedBy: operatorRef,
	correctedAt: Date,
	approvedBy: operatorRef,
	approvedAt: Date
}, { _id: false });

const cartridgeRecordSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	backing: {
		lotId: String,
		lotQrCode: String,
		ovenEntryTime: Date,
		recordedAt: Date
	},
	waxFilling: {
		runId: String, robotId: String, robotName: String, deckId: String, deckPosition: Number,
		waxTubeId: String, waxSourceLot: String, transferTimeSeconds: Number,
		operator: operatorRef, runStartTime: Date, runEndTime: Date, recordedAt: Date
	},
	waxQc: {
		status: { type: String, enum: ['Accepted', 'Rejected', 'Pending'] },
		rejectionReason: String, operator: operatorRef, timestamp: Date, recordedAt: Date
	},
	waxStorage: {
		location: String, coolingTrayId: String, operator: operatorRef, timestamp: Date, recordedAt: Date
	},
	reagentFilling: {
		runId: String, robotId: String, robotName: String,
		assayType: { _id: String, name: String, skuCode: String },
		deckPosition: Number,
		tubeRecords: [{ _id: false, wellPosition: Number, reagentName: String, sourceLotId: String, transferTubeId: String }],
		operator: operatorRef, fillDate: Date, expirationDate: Date, recordedAt: Date
	},
	reagentInspection: {
		status: { type: String, enum: ['Accepted', 'Rejected', 'Pending'] },
		reason: String, operator: operatorRef, timestamp: Date, recordedAt: Date
	},
	topSeal: {
		batchId: String, topSealLotId: String, operator: operatorRef, timestamp: Date, recordedAt: Date
	},
	ovenCure: {
		locationId: String, locationName: String, entryTime: Date, recordedAt: Date
	},
	storage: {
		fridgeId: String, fridgeName: String, locationId: String, containerBarcode: String,
		operator: operatorRef, timestamp: Date, recordedAt: Date
	},
	qaqcRelease: {
		shippingLotId: String, testResult: { type: String, enum: ['pass', 'fail', 'pending'] },
		testedBy: operatorRef, testedAt: Date, notes: String, recordedAt: Date
	},
	shipping: {
		packageId: String, packageBarcode: String,
		customer: { _id: String, name: String, customerType: String, contactName: String, contactEmail: String, contactPhone: String, address: String },
		trackingNumber: String, carrier: String, shippedAt: Date, recordedAt: Date
	},
	assayLoaded: {
		assay: { _id: String, name: String, skuCode: String },
		loadedAt: Date, recordedAt: Date
	},
	testExecution: {
		spu: {
			_id: String, udi: String,
			parts: [{ _id: false, partNumber: String, partName: String, lotNumber: String, serialNumber: String }],
			firmwareVersion: String,
			lastValidation: { type: String, status: String, completedAt: Date },
			particleLink: { particleSerial: String, particleDeviceId: String }
		},
		operator: operatorRef, executedAt: Date, recordedAt: Date
	},
	sample: {
		subjectId: String, sampleType: String, collectedAt: Date,
		collectedBy: operatorRef, metadata: Schema.Types.Mixed, recordedAt: Date
	},
	testResult: {
		analyte: String, value: Number, unit: String,
		referenceRange: { low: Number, high: Number },
		interpretation: String,
		spectroReadings: [{ _id: false, readingNumber: Number, channel: String, value: Number, timestampMs: Number }],
		processedData: Schema.Types.Mixed,
		status: { type: String, enum: ['pending', 'completed', 'failed', 'invalid'] },
		completedAt: Date, recordedAt: Date
	},

	currentPhase: {
		type: String,
		enum: ['backing', 'wax_filled', 'wax_qc', 'wax_stored', 'reagent_filled', 'inspected',
			'sealed', 'cured', 'stored', 'released', 'shipped', 'assay_loaded', 'testing', 'completed', 'voided']
	},

	finalizedAt: Date,
	voidedAt: Date,
	voidReason: String,
	corrections: [correctionSchema]
}, { timestamps: true });

cartridgeRecordSchema.index({ currentPhase: 1 });
cartridgeRecordSchema.index({ 'backing.lotId': 1 });
cartridgeRecordSchema.index({ 'waxFilling.runId': 1 });
cartridgeRecordSchema.index({ 'reagentFilling.runId': 1 });
cartridgeRecordSchema.index({ 'reagentFilling.assayType._id': 1 });
cartridgeRecordSchema.index({ 'storage.locationId': 1 });
cartridgeRecordSchema.index({ 'storage.containerBarcode': 1 });
cartridgeRecordSchema.index({ 'qaqcRelease.shippingLotId': 1 });
cartridgeRecordSchema.index({ 'shipping.packageId': 1 });
cartridgeRecordSchema.index({ currentPhase: 1, 'reagentFilling.expirationDate': 1 });
cartridgeRecordSchema.index({ 'testExecution.spu._id': 1 });
cartridgeRecordSchema.index({ 'sample.subjectId': 1 });
cartridgeRecordSchema.index({ 'testResult.status': 1 });

applySacredMiddleware(cartridgeRecordSchema);

export const CartridgeRecord = mongoose.models.CartridgeRecord || mongoose.model('CartridgeRecord', cartridgeRecordSchema, 'cartridge_records');
