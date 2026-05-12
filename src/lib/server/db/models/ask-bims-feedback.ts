import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * AskBimsFeedback — thumbs up/down on an Ask BIMS answer.
 *
 * Captures the question that was asked, the answer that came back, the tools
 * the agent used, and the operator's rating (+ optional comment on thumbs
 * down). Powers the admin triage view at /admin/ask-bims/feedback so we can
 * spot bad answers and tune the prompt/tools accordingly.
 *
 * The widget UI piece (the thumbs buttons themselves) is a follow-up — this
 * model + the POST /api/agent/ask/feedback endpoint are the server half so
 * a future session can wire the buttons in cheaply.
 */
const askBimsFeedbackSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	// Who + when
	timestamp: { type: Date, required: true, default: () => new Date() },
	userId: { type: String, required: true },
	username: String, // denormalized for fast triage rendering

	// What they were looking at
	responseId: { type: String, required: true, index: true }, // stable id from AskBimsResult
	question: { type: String, required: true },
	answer: { type: String, required: true },
	toolsUsed: { type: [String], default: [] },
	model: { type: String, enum: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'] },
	confidence: { type: String, enum: ['high', 'partial', 'degraded'] },

	// The rating itself
	rating: { type: String, required: true, enum: ['up', 'down'] },
	comment: { type: String, default: null }
}, { timestamps: false });

askBimsFeedbackSchema.index({ timestamp: -1 });
askBimsFeedbackSchema.index({ rating: 1, timestamp: -1 });
askBimsFeedbackSchema.index({ userId: 1, timestamp: -1 });

export const AskBimsFeedback = mongoose.models.AskBimsFeedback
	|| mongoose.model('AskBimsFeedback', askBimsFeedbackSchema, 'ask_bims_feedback');
