import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const integrationSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	// 'mag_criteria' was written by findOneAndUpdate (no validators) before it was in
	// the enum; the screen-pipeline criteria docs (2026-10-13) are declared so a
	// Model.create() of one does not fail validation.
	type: { type: String, enum: ['box', 'particle', 'mag_criteria', 'screen_criteria', 'assay_run_criteria'] },
	/** Free-form criteria body for the *_criteria docs (per test id: min/max/…). */
	criteria: Schema.Types.Mixed,
	updatedBy: String,
	accessToken: String, refreshToken: String, expiresAt: Date,
	bomFolderId: String, bomFileId: String, spreadsheetId: String,
	organizationSlug: String, syncIntervalMinutes: Number,
	isActive: { type: Boolean, default: true },
	lastSyncAt: Date, lastSyncStatus: String, lastSyncError: String
}, { timestamps: true });

export const Integration = mongoose.models.Integration || mongoose.model('Integration', integrationSchema, 'integrations');
