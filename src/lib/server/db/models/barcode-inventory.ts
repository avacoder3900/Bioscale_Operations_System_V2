import mongoose, { Schema } from 'mongoose';

const BarcodeInventorySchema = new Schema({
	_id: { type: String, default: 'default' },
	avery94102SheetsOnHand: { type: Number, default: 0 },
	lastCountedAt: { type: Date },
	lastCountedBy: {
		_id: { type: String },
		username: { type: String }
	},
	alertThreshold: { type: Number, default: 5 }
}, {
	timestamps: true,
	collection: 'barcode_inventory'
});

export const BarcodeInventory = mongoose.models.BarcodeInventory
	|| mongoose.model('BarcodeInventory', BarcodeInventorySchema);
