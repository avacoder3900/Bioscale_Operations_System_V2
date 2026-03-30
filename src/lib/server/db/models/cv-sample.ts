import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const cvSampleSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: { type: String, required: true },
	description: String,
	projectId: { type: String, index: true },
	tags: [String],
	metadata: Schema.Types.Mixed
}, { timestamps: true });

export const CvSample = mongoose.models.CvSample || mongoose.model('CvSample', cvSampleSchema, 'cv_samples');
