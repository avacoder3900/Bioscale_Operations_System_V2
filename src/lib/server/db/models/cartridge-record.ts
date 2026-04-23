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
		lotId: String,               // BackingLot._id (bucket barcode)
		parentLotRecordId: String,   // LotRecord._id — the WI-01 batch
		lotQrCode: String,           // LotRecord.qrCodeRef
		cartridgeBlankLot: String,   // PT-CT-104 input material lot
		thermosealLot: String,       // PT-CT-112 input material lot
		barcodeLabelLot: String,     // PT-CT-106 input material lot
		ovenEntryTime: Date,         // when the bucket entered the backing oven
		ovenExitTime: Date,          // when the cartridge left the bucket onto a deck
		operator: operatorRef,
		recordedAt: Date
	},
	waxFilling: {
		runId: String, robotId: String, robotName: String, deckId: String, deckPosition: Number,
		waxTubeId: String, waxSourceLot: String, transferTimeSeconds: Number, // ORPHANED: never written by any action
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
		// Research runs leave assayType null and flag the cartridge so downstream
		// consumers can distinguish "missing assay data (research)" from "missing
		// assay data (bug)".
		isResearch: Boolean,
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
		locationId: String, locationName: String,
		entryTime: Date, exitTime: Date,
		operator: operatorRef,
		recordedAt: Date
	},
	storage: {
		fridgeId: String, // ORPHANED: never written by any action
		fridgeName: String, locationId: String,
		containerBarcode: String, // ORPHANED: never written by any action
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

	status: {
		type: String,
		enum: [
			'backing', 'wax_filling', 'wax_filled', 'wax_qc', 'wax_stored', 'reagent_filling', 'reagent_filled', 'inspected',
			'sealed', 'cured', 'stored', 'released', 'shipped',
			'linked', 'underway', 'completed', 'cancelled', 'scrapped', 'voided',
			'packeted', 'transferred', 'refrigerated', 'received'
		]
	},

	finalizedAt: Date, // ORPHANED: never written by any action
	voidedAt: Date,
	voidReason: String,
	photos: [{
		_id: false,
		imageId: String,
		phase: String,
		capturedAt: Date
	}],

	corrections: [correctionSchema]
}, { timestamps: true });

cartridgeRecordSchema.index({ status: 1 });
cartridgeRecordSchema.index({ 'backing.lotId': 1 });
cartridgeRecordSchema.index({ 'waxFilling.runId': 1 });
cartridgeRecordSchema.index({ 'reagentFilling.runId': 1 });
cartridgeRecordSchema.index({ 'reagentFilling.assayType._id': 1 });
cartridgeRecordSchema.index({ 'storage.locationId': 1 });
cartridgeRecordSchema.index({ 'storage.containerBarcode': 1 });
cartridgeRecordSchema.index({ 'qaqcRelease.shippingLotId': 1 });
cartridgeRecordSchema.index({ 'shipping.packageId': 1 });
cartridgeRecordSchema.index({ status: 1, 'reagentFilling.expirationDate': 1 });
cartridgeRecordSchema.index({ 'testExecution.spu._id': 1 });
cartridgeRecordSchema.index({ 'sample.subjectId': 1 });
cartridgeRecordSchema.index({ 'testResult.status': 1 });

applySacredMiddleware(cartridgeRecordSchema);

export const CartridgeRecord = mongoose.models.CartridgeRecord || mongoose.model('CartridgeRecord', cartridgeRecordSchema, 'cartridge_records');
