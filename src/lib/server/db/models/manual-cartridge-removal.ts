import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

const manualCartridgeRemovalSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	cartridgeIds: { type: [String], default: [] },
	// Pre-wax (backing-lot) removals decrement BackingLot.cartridgeCount before
	// CartridgeRecords exist, so they have no cartridgeIds. Capture the lot ref
	// and the headcount so Recent Checkouts can render them alongside
	// post-wax-stored removals without a join.
	backingLotId: String,
	cartridgeCount: Number,
	reason: { type: String, required: true },
	operator: operatorRef,
	removedAt: { type: Date, required: true }
}, { timestamps: true });

manualCartridgeRemovalSchema.index({ removedAt: -1 });
manualCartridgeRemovalSchema.index({ 'operator._id': 1 });
manualCartridgeRemovalSchema.index({ cartridgeIds: 1 });
manualCartridgeRemovalSchema.index({ backingLotId: 1 }, { sparse: true });

export const ManualCartridgeRemoval =
	mongoose.models.ManualCartridgeRemoval ||
	mongoose.model('ManualCartridgeRemoval', manualCartridgeRemovalSchema, 'manual_cartridge_removals');
