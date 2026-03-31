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
	modelVersion: String,
	captureSettings: {
		mode: { type: String, enum: ['full', 'raw'], default: 'full' },
		exposure: { type: Number, default: -5 },
		whiteBalance: { type: Number, default: 4000 },
		brightness: { type: Number, default: 128 },
		contrast: { type: Number, default: 128 },
		gain: { type: Number, default: 0 },
		sharpness: { type: Number, default: 128 },
		redCorrection: { type: Number, default: 0.85 },
		greenCorrection: { type: Number, default: 0.90 },
		blueCorrection: { type: Number, default: 1.0 },
		claheStrength: { type: Number, default: 2.0 },
		gamma: { type: Number, default: 0.85 },
		_id: false
	}
}, { timestamps: true });

cvProjectSchema.index({ projectType: 1 });
cvProjectSchema.index({ modelStatus: 1 });

export const CvProject = mongoose.models.CvProject || mongoose.model('CvProject', cvProjectSchema, 'cv_projects');
