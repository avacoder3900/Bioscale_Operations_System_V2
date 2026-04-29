import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

const manualCartridgeRemovalSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	cartridgeIds: { type: [String], default: [] },
	reason: { type: String, required: true },
	operator: operatorRef,
	removedAt: { type: Date, required: true }
}, { timestamps: true });

manualCartridgeRemovalSchema.index({ removedAt: -1 });
manualCartridgeRemovalSchema.index({ 'operator._id': 1 });
manualCartridgeRemovalSchema.index({ cartridgeIds: 1 });

export const ManualCartridgeRemoval =
	mongoose.models.ManualCartridgeRemoval ||
	mongoose.model('ManualCartridgeRemoval', manualCartridgeRemovalSchema, 'manual_cartridge_removals');
