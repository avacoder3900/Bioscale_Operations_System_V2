import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * AskBimsCostLog — per-question cost telemetry. NO question/answer text is
 * stored (no PII concern). Used to power:
 *   - the admin cost dashboard at /admin/ask-bims/cost
 *   - per-user-per-day cap enforcement before each new request
 *
 * Conversation logging (with question/answer text + redaction) is a separate,
 * deferred Phase 6.1 concern. This collection is the cheap-now half.
 */
const askBimsCostLogSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	// Who + when
	userId: { type: String, required: true, index: true },
	username: String, // denormalized for fast dashboard rendering
	timestamp: { type: Date, required: true, default: () => new Date(), index: true },

	// What model + cost
	model: { type: String, required: true, enum: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'] },
	inputTokens: { type: Number, default: 0 },
	outputTokens: { type: Number, default: 0 },
	cacheReadTokens: { type: Number, default: 0 },
	cacheWriteTokens: { type: Number, default: 0 },
	costUsd: { type: Number, required: true, default: 0 },

	// Behavior signals (no content)
	toolCallCount: { type: Number, default: 0 },
	uniqueToolCount: { type: Number, default: 0 },
	durationMs: Number,
	errorClass: String, // 'rate_limit' | 'auth' | 'service_unavailable' | etc, if errored
	wasCapped: { type: Boolean, default: false } // true if request was rejected due to daily cap
}, { timestamps: false });

// Compound indexes for the dashboard's typical queries
askBimsCostLogSchema.index({ userId: 1, timestamp: -1 });
askBimsCostLogSchema.index({ model: 1, timestamp: -1 });
askBimsCostLogSchema.index({ timestamp: -1 });

export const AskBimsCostLog = mongoose.models.AskBimsCostLog || mongoose.model('AskBimsCostLog', askBimsCostLogSchema, 'ask_bims_cost_logs');
