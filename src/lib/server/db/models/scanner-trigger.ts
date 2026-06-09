import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const scannerTriggerSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	deviceId: { type: String, required: true },
	requestedBy: String,
	requestedByUsername: String,
	source: {
		type: String,
		enum: ['test', 'wax_filling', 'reagent_filling', 'manual'],
		default: 'test'
	},
	contextRef: String,
	requestedAt: { type: Date, default: Date.now },
	consumedAt: { type: Date, default: null }
}, { timestamps: false });

scannerTriggerSchema.index({ deviceId: 1, consumedAt: 1, requestedAt: 1 });
scannerTriggerSchema.index({ requestedAt: -1 });

export const ScannerTrigger = mongoose.models.ScannerTrigger
	|| mongoose.model('ScannerTrigger', scannerTriggerSchema, 'scanner_triggers');
