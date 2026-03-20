import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const inviteTokenSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	email: { type: String, required: true },
	token: { type: String, required: true },
	roleId: String,
	invitedBy: String,
	status: { type: String, enum: ['pending', 'accepted', 'expired'], default: 'pending' },
	expiresAt: { type: Date, required: true },
	acceptedAt: Date,
	createdUserId: String,
	createdAt: { type: Date, default: Date.now }
}, { timestamps: false });

inviteTokenSchema.index({ token: 1 }, { unique: true });
inviteTokenSchema.index({ email: 1 });

export const InviteToken = mongoose.models.InviteToken || mongoose.model('InviteToken', inviteTokenSchema, 'invite_tokens');
