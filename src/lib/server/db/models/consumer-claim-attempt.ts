import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * One row per claim attempt from the consumer app, successful or not. Exists
 * for rate limiting (sequential CART-000123 ids are guessable, so a burst of
 * failed claims from one account is an enumeration attempt) and for the
 * ownership report. Rows expire after a day via TTL index.
 */
const consumerClaimAttemptSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	accountId: { type: String, required: true },
	cartridgeId: String,
	outcome: { type: String, required: true },   // 'claimed' | eligibility reason | 'rate_limited'
	at: { type: Date, default: Date.now }
}, { timestamps: false });

consumerClaimAttemptSchema.index({ accountId: 1, at: -1 });
consumerClaimAttemptSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

export const ConsumerClaimAttempt = mongoose.models.ConsumerClaimAttempt
	|| mongoose.model('ConsumerClaimAttempt', consumerClaimAttemptSchema, 'consumer_claim_attempts');
