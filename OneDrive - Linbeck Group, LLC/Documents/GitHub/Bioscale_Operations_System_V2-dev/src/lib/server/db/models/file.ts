import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const fileSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	projectId: String, datasetId: String, filename: String,
	storagePath: String, mimeType: String, fileSize: Number,
	checksum: String, fileType: String, description: String,
	tags: [String], metadata: Schema.Types.Mixed,
	version: { type: Number, default: 1 }, isLatest: Boolean,
	previousVersionId: String,
	uploadedAt: Date, uploadedBy: String, deletedAt: Date
}, { timestamps: false });

export const File = mongoose.models.File || mongoose.model('File', fileSchema, 'files');
