import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

const cvProjectSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: { type: String, required: true },
	description: String,
	purpose: String,
	tags: [String],

	// Training-set composition
	members: { type: [String], default: [] },              // explicit imageIds (snapshot mode)
	composedOf: { type: [String], default: [] },           // projectIds (live mode unions their members at read)
	isLiveComposition: { type: Boolean, default: false },  // false = members[] frozen, true = composedOf flattens at read

	// Deployment — phases where this project's active model runs inference
	deployAtPhases: { type: [String], default: [] },

	// Versioned model registry — append-only. Never overwrite a trainedModels entry.
	trainedModels: [{
		_id: false,
		version: { type: String, required: true },              // e.g. "2026-05-16T14-30-00_a3f8"
		modelPath: { type: String, required: true },            // R2 key for the ONNX
		trainedAt: { type: Date, required: true },
		trainedBy: operatorRef,
		sampleCount: Number,                                     // labeled image count used
		sampleSnapshot: [String],                                // imageIds frozen at training (for replay)
		confidenceThreshold: { type: Number, default: 0.5 },
		notes: String,
		// Lifecycle of the ephemeral (GitHub Actions) training run for this version.
		// 'training' set at dispatch; the train-complete callback flips it to
		// 'ready' or 'failed'. Defaults to 'ready' so pre-existing entries (minted
		// before this field existed) are treated as usable.
		status: { type: String, enum: ['training', 'ready', 'failed'], default: 'ready' },
		completedAt: Date,
		metrics: { type: Schema.Types.Mixed },                   // optional trainer-reported metrics
		errorMessage: String
	}],

	// Production decision-maker. null = no model deployed yet.
	activeModelVersion: { type: String, default: null },

	// Optional shadow model — runs in parallel for evaluation, does NOT decide production.
	shadowModelVersion: { type: String, default: null },

	// Capture settings (LIZA params) — retained for any project that drives a capture station.
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

cvProjectSchema.index({ name: 1 });
cvProjectSchema.index({ deployAtPhases: 1 });

export const CvProject = mongoose.models.CvProject || mongoose.model('CvProject', cvProjectSchema, 'cv_projects');
