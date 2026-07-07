import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

// One immutable entry per training run (CV-PIPELINE-V2 Stage 3/4). Training only
// ever APPENDS here — weights live inside the version, so rollback is just pointing
// activeModelVersion at an older entry. classifier/trainingSet/verification are
// Mixed because they are opaque blobs never queried by sub-field.
const trainedModelSchema = new Schema({
	version: String, // 'v<seq>-lr-cv-color-spatial-v1-<timestamp>'
	status: { type: String, enum: ['trained', 'verified', 'deployed', 'retired'], default: 'trained' },
	classifier: Schema.Types.Mixed, // { weights[156], bias, standardization, calibration, embeddingVersion, embeddingDim }
	confidenceThreshold: Number, // calibrated at train time
	trainedAt: Date,
	trainedBy: operatorRef,
	trainingSet: Schema.Types.Mixed, // { imageIds[], count, approvedCount, rejectedCount, newSincePrevious, filter }
	verification: { type: Schema.Types.Mixed, default: null }, // holdout result — filled by the verify gate
	deployedAt: Date,
	deployedBy: Schema.Types.Mixed,
	legacy: Boolean // true for entries back-filled from the pre-versioned project-level classifier
}, { _id: false });

const cvProjectSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: { type: String, required: true },
	description: String,
	purpose: String,
	projectType: { type: String, enum: ['classification', 'anomaly_detection', 'object_detection'] },
	tags: [String],
	phases: [String],
	labels: [{ name: String, color: String, _id: false }],
	members: [String],

	// Composition (master model): projects assembled from other projects' pools.
	composedOf: [String],
	isLiveComposition: { type: Boolean, default: false },
	isMasterModel: { type: Boolean, default: false },

	imageCount: { type: Number, default: 0 },
	annotatedCount: { type: Number, default: 0 },
	modelStatus: { type: String, enum: ['untrained', 'training', 'trained', 'failed'], default: 'untrained' },
	modelVersion: String,
	// Anomaly-score cutoff for pass/fail at inference time (0..1).
	confidenceThreshold: { type: Number, default: 0.5, min: 0, max: 1 },

	// Deployment routing — declared here so Mongoose preserves them on writes (strict
	// mode silently strips undeclared $set keys, which is what broke deployment saves
	// on master: "No model is deployed at the post_mortem phase").
	deployAtPhases: { type: [String], default: [] },
	activeModelVersion: { type: String, default: null },
	shadowModelVersion: { type: String, default: null },

	// Last training failure message (written by cv-bridge triggerTraining).
	trainingError: { type: String, default: null },

	// DEPRECATED — legacy project-level weights, superseded by per-version weights in
	// trainedModels[].classifier. Kept declared for the migration window so existing
	// writes/reads survive strict mode until migrate-cv-pipeline-v2 wraps it into a
	// trainedModels[] v1 entry.
	classifier: { type: Schema.Types.Mixed, default: null },

	// Training-set assembly filter (Stage 3) — joined against cartridge_records at
	// train time to exclude e.g. voided/scrapped carts or require failure labels.
	trainingFilter: {
		phases: [String],
		cartridgeStatuses: [String],
		requiredTags: [String],
		excludeTags: [String],
		_id: false
	},

	// Per-project verify-gate overrides (Stage 4) — a version must clear these on its
	// holdout before it can flip to 'verified' and become deployable.
	verifyGate: {
		minHoldoutCount: { type: Number, default: 10 },
		minBalancedAccuracy: { type: Number, default: 0.8 },
		_id: false
	},

	// Version history — every model that ever existed stays here with its weights.
	trainedModels: [trainedModelSchema],

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
// Capture routes photos to the deployed model per phase:
// CvProject.find({ deployAtPhases: phase, activeModelVersion: { $ne: null } })
cvProjectSchema.index({ deployAtPhases: 1 });

export const CvProject = mongoose.models.CvProject || mongoose.model('CvProject', cvProjectSchema, 'cv_projects');
