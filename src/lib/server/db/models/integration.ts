import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const integrationSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	type: { type: String, enum: ['box', 'particle'] },
	accessToken: String, refreshToken: String, expiresAt: Date,
	bomFolderId: String, bomFileId: String, spreadsheetId: String,
	organizationSlug: String, syncIntervalMinutes: Number,
	isActive: { type: Boolean, default: true },
	lastSyncAt: Date, lastSyncStatus: String, lastSyncError: String
}, { timestamps: true });

export const Integration = mongoose.models.Integration || mongoose.model('Integration', integrationSchema, 'integrations');
