import mongoose, { Schema } from 'mongoose';

const backingLotSchema = new Schema({
	_id: { type: String }, // the scanned Avery lot barcode IS the ID
	lotType: { type: String, default: 'backing', enum: ['backing'] },
	ovenEntryTime: { type: Date, required: true },
	ovenLocationId: String,
	ovenLocationName: String,
	operator: { _id: String, username: String },
	cartridgeCount: Number,
	status: {
		type: String,
		enum: ['created', 'in_oven', 'ready', 'consumed'],
		default: 'in_oven'
	}
}, { timestamps: true });

backingLotSchema.index({ status: 1 });
backingLotSchema.index({ ovenEntryTime: 1 });
backingLotSchema.index({ 'operator._id': 1 });

export const BackingLot = mongoose.models.BackingLot || mongoose.model('BackingLot', backingLotSchema, 'backing_lots');
