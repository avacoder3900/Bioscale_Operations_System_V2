import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const scannerEventSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	deviceId: { type: String, required: true },
	eventType: {
		type: String,
		enum: ['scan', 'heartbeat', 'error', 'trigger_consumed'],
		required: true
	},
	barcode: String,
	rawPayload: String,
	source: {
		type: String,
		enum: ['test', 'wax_filling', 'reagent_filling', 'manual', 'unknown'],
		default: 'test'
	},
	contextRef: String,
	errorMessage: String,
	metadata: Schema.Types.Mixed,
	receivedAt: { type: Date, default: Date.now }
}, { timestamps: false });

scannerEventSchema.index({ deviceId: 1, receivedAt: -1 });
scannerEventSchema.index({ eventType: 1, receivedAt: -1 });
scannerEventSchema.index({ receivedAt: -1 });

export const ScannerEvent = mongoose.models.ScannerEvent
	|| mongoose.model('ScannerEvent', scannerEventSchema, 'scanner_events');
