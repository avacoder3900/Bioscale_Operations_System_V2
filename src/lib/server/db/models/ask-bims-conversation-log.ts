import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * AskBimsConversationLog — per-question conversation telemetry with the full
 * question + answer text + tool-call summaries.
 *
 * Distinct from AskBimsCostLog (no-content telemetry for caps + cost rollups)
 * — this is the policy-gated half that captures the actual conversation.
 *
 * PII handling: `redactPii()` (in ask-bims.ts) currently no-ops pending a
 * formal policy. Question + answer are stored RAW. When policy lands, swap
 * the no-op for an NER/allowlist redactor and back-fill if required. The
 * collection name keeps `ask_bims_conversation_logs` so future ETL is clean.
 *
 * Joined with AskBimsCostLog by responseId — same id is surfaced in
 * AskBimsResult.responseId so the widget's thumbs feedback also keys to it.
 *
 * Retention is intentionally NOT set at the schema level. Whoever decides
 * the retention policy should attach a TTL index later (currently the same
 * call as the PII redactor sign-off).
 */
const askBimsConversationLogSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },

		// Link key to AskBimsCostLog and to widget feedback
		responseId: { type: String, required: true, index: true },

		// Who + when
		userId: { type: String, required: true, index: true },
		username: String,
		timestamp: { type: Date, required: true, default: () => new Date(), index: true },

		// Conversation content (raw — redactPii() is no-op pending policy)
		question: { type: String, required: true },
		answer: { type: String, default: '' },

		// Compressed tool-call trail. Heavy result payloads are NOT stored — only
		// a short preview so the log is browseable without bloating the DB.
		toolCalls: {
			type: [
				{
					_id: false,
					name: String,
					inputPreview: String,
					resultPreview: String
				}
			],
			default: []
		},

		// What model + behavior signals (mirrors AskBimsCostLog for join-free queries)
		model: {
			type: String,
			required: true,
			enum: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7']
		},
		toolCallCount: { type: Number, default: 0 },
		uniqueToolCount: { type: Number, default: 0 },
		costUsd: { type: Number, default: 0 },
		durationMs: Number,
		errorClass: String,

		// Thumbs feedback — populated after the fact by /api/agent/ask/feedback
		feedback: { type: String, enum: ['up', 'down', null], default: null },
		feedbackAt: Date,
		feedbackNote: String
	},
	{ timestamps: false }
);

// Compound indexes for the admin conversation history view
askBimsConversationLogSchema.index({ userId: 1, timestamp: -1 });
askBimsConversationLogSchema.index({ feedback: 1, timestamp: -1 });
askBimsConversationLogSchema.index({ timestamp: -1 });

export const AskBimsConversationLog =
	mongoose.models.AskBimsConversationLog ||
	mongoose.model(
		'AskBimsConversationLog',
		askBimsConversationLogSchema,
		'ask_bims_conversation_logs'
	);
