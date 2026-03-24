import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const documentSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	documentNumber: String, title: String, category: String,
	currentRevision: String,
	status: { type: String, enum: ['draft', 'in_review', 'approved', 'retired'] },
	effectiveDate: Date, retiredDate: Date, ownerId: String,
	revisions: [{
		_id: { type: String, default: () => generateId() },
		revision: String, content: String, changeDescription: String,
		status: { type: String, enum: ['draft', 'in_review', 'approved'] },
		createdAt: Date, createdBy: String, approvedAt: Date, approvedBy: String,
		approvalSignatureId: String,
		trainingRecords: [{
			_id: { type: String, default: () => generateId() },
			userId: String, username: String, trainedAt: Date,
			trainerId: String, signatureId: String, notes: String
		}]
	}],
	createdBy: String
}, { timestamps: true });

export const Document = mongoose.models.Document || mongoose.model('Document', documentSchema, 'documents');
