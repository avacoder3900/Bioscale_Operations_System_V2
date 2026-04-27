import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * Free-form operator notes attached to the manufacturing analysis page.
 * Lighter-weight than ProcessAnalyticsEvent — no event/process/severity
 * taxonomy, no rejection codes, no linked records. Just operator + body +
 * timestamp. Used as a labor-time observation log; the body is intentionally
 * free-form so operators can write things like "30 min wax setup" without
 * being constrained by a schema. Future structured analysis can mine these
 * via NLP or by adding optional fields without breaking existing rows.
 */
const analyticsNoteSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	body: { type: String, required: true },
	operator: {
		_id: String,
		username: String
	},
	createdAt: { type: Date, default: Date.now }
}, { timestamps: false });

analyticsNoteSchema.index({ createdAt: -1 });
analyticsNoteSchema.index({ 'operator._id': 1, createdAt: -1 });

export const AnalyticsNote = mongoose.models.AnalyticsNote
	|| mongoose.model('AnalyticsNote', analyticsNoteSchema, 'analytics_notes');
