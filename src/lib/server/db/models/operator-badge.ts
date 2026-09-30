import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

/**
 * OperatorBadge — a printed QR badge that identifies a user at a scan box
 * (BADGE-SYSTEM_PLAN.md §15.1). `code` is the value the QR encodes: random
 * (BDG- + 10 chars, no 0/O/1/I), never sequential, and stored in plaintext so
 * the portal can reprint it (§14 #1). One ACTIVE badge per user — enforced by
 * the partial unique index, not by app code. Revoke, never delete.
 */
const operatorBadgeSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	code: { type: String, required: true },        // 'BDG-XXXXXXXXXX', uppercase
	userId: { type: String, required: true },      // User._id
	username: String,                              // snapshot at issue
	displayName: { type: String, required: true }, // what is printed on the card
	status: { type: String, enum: ['active', 'revoked'], default: 'active' },
	issuedAt: Date,
	issuedBy: operatorRef,
	revokedAt: Date,
	revokedBy: operatorRef,
	revokeReason: String,
	lastUsedAt: Date,                              // bumped by resolveBadge()
	printCount: { type: Number, default: 0 }       // bumped by the print page
}, { timestamps: true });

operatorBadgeSchema.index({ code: 1 }, { unique: true });
operatorBadgeSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
operatorBadgeSchema.index({ status: 1, issuedAt: -1 });

// Same delete block as user.ts: a badge is history the moment it is issued.
const blockDelete = function (next: (err?: Error) => void) {
	return next(new Error('Badges cannot be deleted — revoke instead'));
};
(operatorBadgeSchema.pre as any)('deleteOne', blockDelete);
(operatorBadgeSchema.pre as any)('deleteMany', blockDelete);
(operatorBadgeSchema.pre as any)('findOneAndDelete', blockDelete);

export const OperatorBadge = mongoose.models.OperatorBadge
	|| mongoose.model('OperatorBadge', operatorBadgeSchema, 'operator_badges');
