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
// TTL: auto-delete after 30 days
deviceLogSchema.index({ uploadedAt: 1 }, { expireAfterSeconds: 2592000 });

applyImmutableMiddleware(deviceLogSchema);

export const DeviceLog = mongoose.models.DeviceLog || mongoose.model('DeviceLog', deviceLogSchema, 'device_logs');
