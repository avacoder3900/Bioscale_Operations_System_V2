import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const receivingLotSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	lotId: { type: String, required: true }, // scanned barcode value (unique)
	lotNumber: String, // system-generated LOT-YYYYMMDD-XXXX
	part: {
		_id: String,
		partNumber: String,
		name: String
	},
	quantity: { type: Number, required: true },
	serialNumber: String,
	operator: { _id: String, username: String },
	inspectionPathway: { type: String, enum: ['coc', 'ip'], required: true },
	cocDocumentUrl: String,
	cocMeetsStandards: Boolean,
	ipResults: Schema.Types.Mixed, // { result, passRate, percentRequired }
	ipRevisionId: String, // InspectionProcedureRevision._id
	firstArticleInspection: { type: Boolean, default: false },
	poReference: String,
	supplier: String,
	vendorLotNumber: String,
	bagBarcode: String, // barcode label placed on storage bag
	expirationDate: Date,
	storageConditionsRequired: { type: Boolean, default: false },
	esdHandlingRequired: { type: Boolean, default: false },
	checklist: {
		packingSlipIncluded: { type: String, enum: ['yes', 'no', 'na'] },
		materialLabeledIdentified: { type: String, enum: ['yes', 'no', 'na'] },
		materialProperlyPackaged: { type: String, enum: ['yes', 'no', 'na'] },
		materialFreeOfDefects: { type: String, enum: ['yes', 'no', 'na'] },
		purchaseOrderRequirementsMet: { type: String, enum: ['yes', 'no', 'na'] }
	},
	formFitFunctionCheck: { type: String, enum: ['pass', 'fail', 'na'] },
	notes: String,
	photos: { type: [String], default: [] },
	additionalDocuments: { type: [String], default: [] },
	overrideApplied: { type: Boolean, default: false },
	overrideReason: String,
	overrideBy: { _id: String, username: String },
	overrideAt: Date,
	dispositionType: { type: String, enum: ['accepted', 'rejected', 'returned', 'other'] },
	totalRejects: Number,
	defectDescription: String,
	ncNumber: String,
	rmaNumber: String,
	dispositionExplanation: String,
	disposedAt: Date,
	disposedBy: { _id: String, username: String },
	status: { type: String, enum: ['in_progress', 'accepted', 'rejected', 'returned', 'other'], default: 'in_progress' }
}, { timestamps: true });

receivingLotSchema.index({ lotId: 1 }, { unique: true });
receivingLotSchema.index({ lotNumber: 1 });
receivingLotSchema.index({ bagBarcode: 1 }, { sparse: true });
receivingLotSchema.index({ 'part._id': 1 });
receivingLotSchema.index({ status: 1 });
receivingLotSchema.index({ createdAt: -1 });

export const ReceivingLot = mongoose.models.ReceivingLot
	|| mongoose.model('ReceivingLot', receivingLotSchema, 'receiving_lots');
