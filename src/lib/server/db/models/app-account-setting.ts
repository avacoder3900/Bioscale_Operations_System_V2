import mongoose, { Schema } from 'mongoose';

/**
 * Consumer-app account type and clinic enrollment (docs/CONSUMER-OWNERSHIP.md
 * "Account types"). `_id` is the app_users._id (`provider:sub`). BIMS owns and
 * writes this; the app reads it on every request to decide what an account
 * sees. No row = an individual account that is not enrolled anywhere, which is
 * how every account starts — the app never writes here.
 *
 * - individual: sees the cartridges assigned to it.
 * - clinic: also sees the cartridges of every individual enrolled under it.
 * - dev: sees every result in the app.
 *
 * `clinicAccountId` is set only on individual accounts and names a clinic-type
 * account. History lives in the audit log (`tableName: 'app_account_settings'`).
 */
export const APP_ACCOUNT_TYPES = ['individual', 'clinic', 'dev'] as const;
export type AppAccountType = (typeof APP_ACCOUNT_TYPES)[number];

const appAccountSettingSchema = new Schema({
	_id: String,
	accountType: { type: String, enum: APP_ACCOUNT_TYPES, default: 'individual' },
	clinicAccountId: { type: String, default: null, index: true },
	enrolledAt: { type: Date, default: null },
	enrolledBy: { type: { _id: String, username: String }, default: null, _id: false },
	updatedBy: { type: { _id: String, username: String }, default: null, _id: false },
	updatedAt: { type: Date, default: Date.now }
}, { timestamps: false });

export const AppAccountSetting = mongoose.models.AppAccountSetting
	|| mongoose.model('AppAccountSetting', appAccountSettingSchema, 'app_account_settings');
