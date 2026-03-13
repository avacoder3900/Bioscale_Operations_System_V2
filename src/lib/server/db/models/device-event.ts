import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const deviceEventSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	deviceId: String,
	eventType: { type: String, enum: ['validate', 'load_assay', 'upload', 'reset', 'error'] },
	eventData: Schema.Types.Mixed, cartridgeUuid: String,
	success: Boolean, errorMessage: String,
	createdAt: { type: Date, default: Date.now }
}, { timestamps: false });

applyImmutableMiddleware(deviceEventSchema);

export const DeviceEvent = mongoose.models.DeviceEvent || mongoose.model('DeviceEvent', deviceEventSchema, 'device_events');
