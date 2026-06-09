import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * AskBimsFeedback — operator signal on an Ask BIMS answer.
 *
 * Two kinds of signal, can coexist on one row:
 *   1. rating: thumbs up/down — quality verdict ("this answer was wrong/right")
 *   2. flagged: bookmark-for-review — "Claude should look at this later"
 *      (independent of correctness; for surfacing patterns, not just errors)
 *
 * Either rating OR flagged must be present. comment/flagReason are optional
 * free-text. Powers the admin triage view at /admin/ask-bims/feedback and the
 * flagged-conversations review queue at /admin/ask-bims/review.
 *
 * The "flag" widget UI piece is a follow-up — same pattern as the thumbs
 * buttons; this model + POST /api/agent/ask/feedback is the server half.
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

	// Rating: thumbs verdict. Optional — a row can be flag-only with no rating.
	rating: { type: String, enum: ['up', 'down', null], default: null },
	comment: { type: String, default: null },

	// Flag-for-review: "Claude, look at this conversation later." Independent of
	// rating — operator can flag a correct-but-interesting answer OR a wrong one.
	flagged: { type: Boolean, default: false, index: true },
	flagReason: { type: String, default: null },

	// Degraded-answer operator note. Captured when the operator investigates a
	// degraded-confidence answer and either (a) explains why the caveat is
	// benign ("shift break, no runs expected") or (b) provides a correction
	// to log against the underlying data gap. degradedReasons is the snapshot
	// of confidenceReasons at the moment of capture, so the review queue can
	// still see what the operator was responding to even after upstream
	// tool results have rolled off.
	degradedNote: { type: String, default: null },
	degradedReasons: { type: [String], default: [] },

	// Resolution lifecycle for the flagged queue — admin marks "reviewed" after
	// looking at it. Lets the queue surface only un-reviewed items by default.
	reviewedAt: { type: Date, default: null },
	reviewedBy: { type: String, default: null }
}, { timestamps: false });

askBimsFeedbackSchema.index({ timestamp: -1 });
askBimsFeedbackSchema.index({ rating: 1, timestamp: -1 });
askBimsFeedbackSchema.index({ userId: 1, timestamp: -1 });
askBimsFeedbackSchema.index({ flagged: 1, reviewedAt: 1, timestamp: -1 });

export const AskBimsFeedback = mongoose.models.AskBimsFeedback
	|| mongoose.model('AskBimsFeedback', askBimsFeedbackSchema, 'ask_bims_feedback');
