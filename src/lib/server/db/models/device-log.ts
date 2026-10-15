import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const deviceLogSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	// Device identification
	deviceId: { type: String, required: true },
	deviceName: { type: String },

	// Session identification
	sessionId: { type: String, required: true },
	firmwareVersion: { type: Number },
	dataFormatVersion: { type: Number },
	bootCount: { type: Number },
	bootTime: { type: Date },

	// Upload metadata
	uploadedAt: { type: Date, default: Date.now, required: true },

	// Log content — array of {ms, message}
	logLines: [{
		_id: false,
		ms: { type: Number },
		message: { type: String }
	}],

	// Summary fields (computed by middleware on insert)
	lineCount: { type: Number, default: 0 },
	errorCount: { type: Number, default: 0 },
	hasCrash: { type: Boolean, default: false },
	firstLine: { type: String },
	lastLine: { type: String }
}, {
	timestamps: false,
	collection: 'device_logs'
});

deviceLogSchema.index({ deviceId: 1, uploadedAt: -1 });
deviceLogSchema.index({ hasCrash: 1, uploadedAt: -1 });
deviceLogSchema.index({ sessionId: 1 }, { unique: true });
// TTL: auto-delete after 1 year. The firmware log is the one diagnostic source nothing can regenerate,
// and it is the smallest of the diagnostic collections (device_events / webhook_logs stay at 30 days).
// Changing this value needs a collMod on the live index (done 2026-10-14 for the 1-year value);
// mongoose autoIndex will not alter an existing TTL.
deviceLogSchema.index({ uploadedAt: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });

applyImmutableMiddleware(deviceLogSchema);

export const DeviceLog = mongoose.models.DeviceLog || mongoose.model('DeviceLog', deviceLogSchema, 'device_logs');
