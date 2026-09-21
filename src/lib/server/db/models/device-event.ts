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

// Robot-arm control page + equipment detail + Ask-BIMS all filter by
// deviceId/eventType — without this they walk the whole telemetry collection
// (Atlas query-targeting alert, 2026-07-31).
deviceEventSchema.index({ deviceId: 1, eventType: 1, createdAt: -1 });

export const DeviceEvent = mongoose.models.DeviceEvent || mongoose.model('DeviceEvent', deviceEventSchema, 'device_events');
