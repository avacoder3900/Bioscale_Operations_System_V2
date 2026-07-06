import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

/**
 * CvProject — organizes ONE model per manufacturing concern (e.g. one per
 * mfg step). Projects do NOT own photos: the training set is derived from
 * cartridge_records.photos[] entries whose phase is in `phases` and whose
 * qcLabel is set. Human labels never live here; model state ONLY lives here.
 *
 * Data flow: cartridge photos[] (truth) → training (cv-bridge) →
 * trainedModels[] entry here → activeModelVersion → inference on capture →
 * cv_inspections (machine verdicts).
 */

// A trained logistic-regression model. Weights are small (~embeddingDim
// floats), so every version is kept for rollback/comparison; activeModelVersion
// selects which one grades new captures.
const trainedModelSchema = new Schema({
	version: { type: String, required: true },
	trainedAt: Date,
	trainedBy: operatorRef,

	classifier: {
		weights: [Number],
		bias: Number,
		featureMeans: [Number],
		featureStds: [Number],
		calibrationMin: Number,
		calibrationMax: Number,
		embeddingDim: Number,
		embeddingVersion: String
	},

	// Training-set composition + metrics. holdout* comes from a stratified
	// ~20% split never seen during fitting — trust these over training*.
	samplesUsed: Number,
	approvedCount: Number,
	rejectedCount: Number,
	trainingAccuracy: Number,
	trainingLogLoss: Number,
	holdoutAccuracy: Number,
	holdoutF1: Number,
	holdoutSamples: Number,

	confidenceThreshold: { type: Number, default: 0.5, min: 0, max: 1 }
}, { _id: false });

const cvProjectSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: { type: String, required: true },
	description: String,
	projectType: {
		type: String,
		enum: ['classification', 'anomaly_detection', 'object_detection'],
		default: 'classification'
	},

	// The project's scope: which manufacturing phases it trains on AND deploys
	// at. One field — training set and inference routing can never disagree.
	phases: [String],

	modelStatus: {
		type: String,
		enum: ['untrained', 'training', 'trained', 'failed'],
		default: 'untrained'
	},
	trainingError: String,

	trainedModels: [trainedModelSchema],
	// Version string of the trainedModels[] entry grading new captures.
	activeModelVersion: { type: String, default: null },
	// Optional second model run silently alongside the active one for
	// comparison before promotion. Its verdicts are marked isShadow.
	shadowModelVersion: { type: String, default: null },

	// Default pass/fail cutoff; a trainedModels[] entry may override.
	confidenceThreshold: { type: Number, default: 0.5, min: 0, max: 1 },

	// LIZA camera profile applied by capture UIs for this project's phases.
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

cvProjectSchema.index({ phases: 1, activeModelVersion: 1 }); // phase-inference routing
cvProjectSchema.index({ modelStatus: 1 });

export const CvProject = mongoose.models.CvProject || mongoose.model('CvProject', cvProjectSchema, 'cv_projects');
