import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const cvProjectSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: { type: String, required: true },
	description: String,
	purpose: String,
	confidenceThreshold: { type: Number, default: 0.5, min: 0, max: 1 },
	isMasterModel: { type: Boolean, default: false },
	projectType: { type: String, enum: ['classification', 'anomaly_detection', 'object_detection'] },
	tags: [String],
	phases: [String],
	labels: [{ name: String, color: String, _id: false }],
	imageCount: { type: Number, default: 0 },
	annotatedCount: { type: Number, default: 0 },
	modelStatus: { type: String, enum: ['untrained', 'training', 'trained', 'failed'], default: 'untrained' },
	modelVersion: String,
	classifier: {
		weights: { type: [Number], default: undefined },
		bias: { type: Number, default: 0 },
		featureMeans: { type: [Number], default: undefined },
		featureStds: { type: [Number], default: undefined },
		calibrationMin: { type: Number, default: 0 },
		calibrationMax: { type: Number, default: 1 },
		samplesUsed: { type: Number, default: 0 },
		approvedCount: { type: Number, default: 0 },
		rejectedCount: { type: Number, default: 0 },
		embeddingDim: { type: Number },
		embeddingVersion: String,
		trainedAt: Date,
		trainingLogLoss: Number,
		trainingAccuracy: Number,
		_id: false
	},
	trainingError: String,
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
// Only one project can be the master model. Sparse + partial filter so non-master rows don't collide.
cvProjectSchema.index(
	{ isMasterModel: 1 },
	{ unique: true, partialFilterExpression: { isMasterModel: true } }
);

export const CvProject = mongoose.models.CvProject || mongoose.model('CvProject', cvProjectSchema, 'cv_projects');
