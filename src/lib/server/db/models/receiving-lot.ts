import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const receivingLotSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	lotId: { type: String, required: true }, // scanned barcode value (unique)
	part: {
		_id: String,
		partNumber: String,
		name: String
	},
	quantity: { type: Number, required: true },
	operator: { _id: String, username: String },
	inspectionPathway: { type: String, enum: ['coc', 'ip'], required: true },
	cocDocumentUrl: String,
	ipResults: Schema.Types.Mixed, // { result, passRate, percentRequired }
	ipRevisionId: String, // InspectionProcedureRevision._id
	poReference: String,
	supplier: String,
	vendorLotNumber: String,
	expirationDate: Date,
	photos: { type: [String], default: [] },
	additionalDocuments: { type: [String], default: [] },
	overrideApplied: { type: Boolean, default: false },
	overrideReason: String,
	overrideBy: { _id: String, username: String },
	overrideAt: Date,
	status: { type: String, enum: ['accepted', 'rejected'], default: 'accepted' }
}, { timestamps: true });

receivingLotSchema.index({ lotId: 1 }, { unique: true });
receivingLotSchema.index({ 'part._id': 1 });
receivingLotSchema.index({ status: 1 });
receivingLotSchema.index({ createdAt: -1 });

export const ReceivingLot = mongoose.models.ReceivingLot
	|| mongoose.model('ReceivingLot', receivingLotSchema, 'receiving_lots');
