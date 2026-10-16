import mongoose, { Schema } from 'mongoose';

/**
 * Blocked consumer-app accounts. `_id` is the app_users._id (`provider:sub`).
 * BIMS owns and writes this; the consumer app checks it on every request and
 * refuses a session whose account is listed (bioscale-app hooks.server.ts).
 * Blocking does not delete anything: the profile, links and ownership rows
 * stay, so unblocking restores the account exactly.
 */
const appAccountBlockSchema = new Schema({
	_id: String,
	reason: { type: String, required: true },
	blockedBy: { _id: String, username: String },
	blockedAt: { type: Date, default: Date.now }
}, { timestamps: false });

export const AppAccountBlock = mongoose.models.AppAccountBlock
	|| mongoose.model('AppAccountBlock', appAccountBlockSchema, 'app_account_blocks');
