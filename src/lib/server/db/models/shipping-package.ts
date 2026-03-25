import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const shippingPackageSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	barcode: String,
	customer: { _id: String, name: String, customerType: String, contactName: String, contactEmail: String, contactPhone: String, address: String },
	trackingNumber: String, carrier: String,
	status: { type: String, enum: ['created', 'packing', 'packed', 'shipped', 'delivered'] },
	notes: String, packedBy: String, packedAt: Date, shippedAt: Date, deliveredAt: Date,
	cartridges: [{ _id: false, cartridgeId: String, addedAt: Date }]
}, { timestamps: true });

export const ShippingPackage = mongoose.models.ShippingPackage || mongoose.model('ShippingPackage', shippingPackageSchema, 'shipping_packages');
