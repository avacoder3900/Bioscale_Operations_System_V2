import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const deviceEventSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	deviceId: String,
	eventType: { type: String, required: true },
	eventData: Schema.Types.Mixed, cartridgeUuid: String,
	success: Boolean, errorMessage: String,
	createdAt: { type: Date, default: Date.now }
}, { timestamps: false });

// TTL: auto-delete after 30 days
deviceEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });

applyImmutableMiddleware(deviceEventSchema);

export const DeviceEvent = mongoose.models.DeviceEvent || mongoose.model('DeviceEvent', deviceEventSchema, 'device_events');
