import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const failureLabelSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	text: { type: String, required: true },
	createdBy: { _id: String, username: String },
	createdAt: { type: Date, default: () => new Date() }
});

failureLabelSchema.index({ text: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export const FailureLabel = mongoose.models.FailureLabel || mongoose.model('FailureLabel', failureLabelSchema, 'failure_labels');
