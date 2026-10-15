import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * SONIC anomaly ignore rule: anomalies matching it, on every SONIC recording, are
 * marked ignored (kept and shown, but left out of the counts). E.g. the end-of-test
 * beep (steps 47–48) or compression artifacts (above ~8 kHz). A rule is never
 * deleted — removing it sets removedAt/removedBy, so the history stays readable.
 */
const sonicIgnoreRuleSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: { type: String, required: true },
	reason: { type: String, required: true },
	kind: { type: String, default: null }, // null = any kind
	stepFrom: { type: Number, default: null },
	stepTo: { type: Number, default: null },
	fMinHz: { type: Number, default: null }, // anomaly's lowest frequency ≥ this
	fMaxHz: { type: Number, default: null }, // anomaly's highest frequency ≤ this
	createdBy: { _id: String, username: String },
	createdAt: { type: Date, default: () => new Date() },
	removedBy: { _id: String, username: String },
	removedAt: { type: Date, default: null }
});

export const SonicIgnoreRule =
	mongoose.models.SonicIgnoreRule || mongoose.model('SonicIgnoreRule', sonicIgnoreRuleSchema, 'sonic_ignore_rules');
