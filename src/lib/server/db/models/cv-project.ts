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
	// Trained in-process logistic-regression classifier (weights, bias,
	// standardization + calibration params). Written wholesale by triggerTraining.
	// Mixed because it's an opaque model blob, never queried by sub-field.
	// MUST be a declared path — Mongoose strict mode silently drops undeclared
	// keys from $set, which previously discarded the trained model entirely.
	classifier: { type: Schema.Types.Mixed, default: null },
	trainingError: { type: String, default: null },
	// Phases at which this project's trained classifier auto-runs inference on
	// capture (see run-inference.ts). Declared so deployment config persists.
	deployAtPhases: { type: [String], default: [] },
	// Pass-probability cutoff for pass/fail at inference time (0..1).
	confidenceThreshold: { type: Number, default: 0.5, min: 0, max: 1 },
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
cvProjectSchema.index({ deployAtPhases: 1 });

export const CvProject = mongoose.models.CvProject || mongoose.model('CvProject', cvProjectSchema, 'cv_projects');
