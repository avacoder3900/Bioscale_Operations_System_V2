import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const cvProjectSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: { type: String, required: true },
	description: String,
	projectType: { type: String, enum: ['classification', 'anomaly_detection', 'object_detection'] },
	tags: [String],
	phases: [String],
	labels: [{ name: String, color: String, _id: false }],
	imageCount: { type: Number, default: 0 },
	annotatedCount: { type: Number, default: 0 },
	modelStatus: { type: String, enum: ['untrained', 'training', 'trained', 'failed'], default: 'untrained' },
	modelVersion: String
}, { timestamps: true });

cvProjectSchema.index({ projectType: 1 });
cvProjectSchema.index({ modelStatus: 1 });

export const CvProject = mongoose.models.CvProject || mongoose.model('CvProject', cvProjectSchema, 'cv_projects');
