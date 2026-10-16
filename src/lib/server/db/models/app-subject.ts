import mongoose, { Schema } from 'mongoose';

/**
 * Read-only mirror of the consumer app's `subjects` collection — the people
 * whose blood is in a cartridge (a consumer themselves, or a clinic's
 * patient). Owned and written by bioscale-app (src/lib/server/subjects.ts).
 * Patient names are PHI: BIMS reads this only to label an ownership row on
 * the DHR page for users who already hold cartridgeAdmin:read.
 */
const appSubjectSchema = new Schema({
	_id: String,
	customerId: String,
	accountId: String,
	displayName: String,
	archivedAt: Date
}, { strict: false, timestamps: false });

export const AppSubject = mongoose.models.AppSubject || mongoose.model('AppSubject', appSubjectSchema, 'subjects');
