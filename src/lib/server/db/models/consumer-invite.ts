import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * An invitation for a consumer-app account to join a customer with a role.
 * Distinct from `invite_tokens`, which create BIMS users. Only the SHA-256 of
 * the token is stored; the token itself travels in the link once. Created by
 * a BIMS operator (customer page) or by a clinic admin from the app (consumer
 * API); accepted through the consumer API while signed in to the app.
 */
const consumerInviteSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	customerId: { type: String, required: true },
	email: { type: String, required: true },        // normalised lower-case
	role: { type: String, enum: ['admin', 'staff', 'member'], required: true },
	tokenHash: { type: String, required: true },
	status: { type: String, enum: ['pending', 'accepted', 'revoked', 'expired'], default: 'pending' },
	createdBy: { kind: String, id: String, label: String },
	expiresAt: { type: Date, required: true },
	acceptedAt: Date,
	acceptedAccountId: String,
	revokedAt: Date
}, { timestamps: true });

consumerInviteSchema.index({ tokenHash: 1 }, { unique: true });
consumerInviteSchema.index({ customerId: 1, status: 1 });
consumerInviteSchema.index({ email: 1, status: 1 });

export const ConsumerInvite = mongoose.models.ConsumerInvite
	|| mongoose.model('ConsumerInvite', consumerInviteSchema, 'consumer_invites');
