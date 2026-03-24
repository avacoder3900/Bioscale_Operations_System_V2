import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

// FIX-03: Typed sub-schema replacing Schema.Types.Mixed for inputLots
const inputLotSchema = new Schema({
	materialName: String,
	barcode: String,
	partDefinitionId: String,
	scanOrder: Number,
	scannedAt: Date
}, { _id: false });

const lotRecordSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	qrCodeRef: { type: String, required: true },
	processConfig: { _id: String, processName: String, processType: String },
	operator: operatorRef,
	inputLots: { type: [inputLotSchema], default: undefined }, // typed array (backward-compatible)
	quantityProduced: Number,
	desiredQuantity: Number,
	quantityDiscrepancyReason: String,

	stepEntries: [{
		_id: { type: String, default: () => generateId() },
		stepId: String, stepNumber: Number, stepTitle: String,
		note: String, imageUrl: String, operator: operatorRef, completedAt: Date
	}],

	startTime: Date, finishTime: Date, cycleTime: Number,
	ovenEntryTime: Date, wiRevision: String, status: String,
	cartridgeIds: [String],
	// LOT TRACEABILITY (ISO 13485) — output lot number for this batch
	outputLotNumber: String  // auto-generated LOT-YYYYMMDD-XXXX for this production batch
}, { timestamps: true });

lotRecordSchema.index({ qrCodeRef: 1 }, { unique: true });
lotRecordSchema.index({ 'processConfig._id': 1 });
lotRecordSchema.index({ status: 1 });
lotRecordSchema.index({ 'operator._id': 1 });

export const LotRecord = mongoose.models.LotRecord || mongoose.model('LotRecord', lotRecordSchema, 'lot_records');
