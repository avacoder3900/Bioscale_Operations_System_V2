import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const webhookLogSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	deviceId: { type: String, required: true },
	eventName: { type: String, required: true },
	timestamp: { type: Date, default: Date.now, required: true },
	processingTimeMs: { type: Number },

	// What the device sent
	request: {
		_id: false,
		raw: { type: String },
		parsed: { type: Schema.Types.Mixed },
		particlePublishedAt: { type: Date }
	},

	// What the Lambda sent back
	response: {
		_id: false,
		status: { type: String },
		data: { type: Schema.Types.Mixed },
		errorMessage: { type: String }
	},

	// Correlation fields
	cartridgeId: { type: String },
	assayId: { type: String },
	firmwareVersion: { type: Number }
}, {
	timestamps: false,
	collection: 'webhook_logs'
});

webhookLogSchema.index({ deviceId: 1, timestamp: -1 });
webhookLogSchema.index({ eventName: 1, timestamp: -1 });
webhookLogSchema.index({ 'response.status': 1, timestamp: -1 });
// TTL: auto-delete after 30 days
webhookLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 2592000 });

applyImmutableMiddleware(webhookLogSchema);

export const WebhookLog = mongoose.models.WebhookLog || mongoose.model('WebhookLog', webhookLogSchema, 'webhook_logs');
