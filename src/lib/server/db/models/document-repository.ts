import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const documentRepositorySchema = new Schema({
	_id: { type: String, default: () => generateId() },
	fileName: String, originalFileName: String, fileSize: Number,
	mimeType: String, category: String, tags: [String],
	content: String, description: String,
	uploadedAt: Date, uploadedBy: String
}, { timestamps: false });

export const DocumentRepository = mongoose.models.DocumentRepository || mongoose.model('DocumentRepository', documentRepositorySchema, 'document_repository');
