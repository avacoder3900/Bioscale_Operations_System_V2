import mongoose, { Schema } from 'mongoose';

/**
 * Mirror of the consumer app's `app_users` collection (bioscale-app,
 * src/lib/server/profile.ts owns the shape). `_id` is `${provider}:${sub}`.
 * BIMS reads it to show who an account is on the customer page and the
 * ownership report. It writes it in two places only: dev accounts, and the
 * results email (consumer/accounts.ts setResultsEmail).
 */
const appUserSchema = new Schema({
	_id: String,
	provider: String,
	sub: String,
	signInEmail: String,
	name: String,
	bioscaleEmail: String,
	bioscaleEmailVerifiedAt: Date,
	lastSignInAt: Date
}, { strict: false, timestamps: false });

export const AppUser = mongoose.models.AppUser || mongoose.model('AppUser', appUserSchema, 'app_users');
