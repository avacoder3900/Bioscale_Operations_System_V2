import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const shippingLotSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	assayType: { _id: String, name: String },
	customer: { _id: String, name: String },
	status: { type: String, enum: ['open', 'testing', 'released', 'shipped', 'cancelled'] },
	cartridgeCount: Number, releasedAt: Date, releasedBy: String, notes: String,
	qaqcReleases: [{
		_id: { type: String, default: () => generateId() },
		reagentRunId: String, qaqcCartridgeIds: [String],
		testResult: { type: String, enum: ['pass', 'fail', 'pending'] },
		testedBy: { _id: String, username: String }, testedAt: Date, notes: String, createdAt: Date
	}]
}, { timestamps: true });

export const ShippingLot = mongoose.models.ShippingLot || mongoose.model('ShippingLot', shippingLotSchema, 'shipping_lots');
