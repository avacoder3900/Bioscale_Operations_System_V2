import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * Customer ↔ consumer-app account link. A plain consumer is a customer of one
 * with a single `member` row; a clinic has several accounts with `admin` /
 * `staff` roles. Written by BIMS only: by an operator on the customer page or
 * by the consumer invite-accept endpoint. The consumer app reads it directly
 * to decide which customers' cartridges an account may see.
 */
export const CUSTOMER_ACCOUNT_ROLES = ['admin', 'staff', 'member'] as const;
export type CustomerAccountRole = (typeof CUSTOMER_ACCOUNT_ROLES)[number];

const customerAccountSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	customerId: { type: String, required: true },   // customers._id
	accountId: { type: String, required: true },    // app_users._id
	email: String,                                  // the account's sign-in email at link time (display only)
	role: { type: String, enum: CUSTOMER_ACCOUNT_ROLES, required: true },
	status: { type: String, enum: ['active', 'revoked'], default: 'active' },
	inviteId: String,                               // consumer_invites._id when linked via invite
	linkedBy: { kind: String, id: String, label: String },
	linkedAt: { type: Date, default: Date.now },
	revokedAt: Date,
	revokedBy: { kind: String, id: String, label: String }
}, { timestamps: true });

customerAccountSchema.index({ customerId: 1, accountId: 1 }, { unique: true });
customerAccountSchema.index({ accountId: 1, status: 1 });
customerAccountSchema.index({ customerId: 1, status: 1 });

export const CustomerAccount = mongoose.models.CustomerAccount
	|| mongoose.model('CustomerAccount', customerAccountSchema, 'customer_accounts');
