import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

// Optical-test cartridges are manufactured off the standard product workflow and used only for
// SPU optical confirmation. Kept in their own collection so they never enter the product
// (CartridgeRecord) / shipping pipeline.
const opticalTestCartridgeSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		barcode: String,
		serialNumber: String,
		lotNumber: String,
		assay: { _id: String, name: String, skuCode: String },
		groupId: String, // -> ValidationGroup
		status: {
			type: String,
			enum: ['available', 'in_use', 'depleted', 'expired', 'quarantine', 'disposed'],
			default: 'available'
		},
		expirationDate: Date,
		notes: String,
		usageLog: [
			{
				_id: { type: String, default: () => generateId() },
				action: {
					type: String,
					enum: ['registered', 'used', 'returned', 'quarantined', 'disposed', 'status_changed']
				},
				previousValue: String,
				newValue: String,
				spuId: String,
				validationSessionId: String,
				notes: String,
				performedBy: operatorRef,
				performedAt: Date
			}
		],
		createdBy: String
	},
	{ timestamps: true }
);

opticalTestCartridgeSchema.index({ barcode: 1 });
opticalTestCartridgeSchema.index({ groupId: 1 });
opticalTestCartridgeSchema.index({ status: 1 });

export const OpticalTestCartridge =
	mongoose.models.OpticalTestCartridge ||
	mongoose.model('OpticalTestCartridge', opticalTestCartridgeSchema, 'optical_test_cartridges');
