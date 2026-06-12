import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const cvInspectionSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	// What was inspected
	imageId: { type: String, required: true, index: true },
	cartridgeRecordId: { type: String, required: true, index: true },
	phase: { type: String, required: true },

	// Which model decided
	projectId: { type: String, required: true, index: true },
	modelVersion: { type: String, required: true },       // matches CvProject.trainedModels[].version
	modelPath: { type: String, required: true },         // R2 key of the ONNX used
	isShadow: { type: Boolean, default: false },         // true = parallel A/B inference, not the production decision

	// Decision
	result: { type: String, enum: ['pass', 'fail', null], default: null },
	confidenceScore: Number,
	rawScore: Number,                                     // unnormalized model output
	anomalyScore: Number,                                 // normalized score (back-compat)
	confidenceThreshold: Number,
	defects: [{ type: String, location: String, severity: String, _id: false }],

	// Operator disposition of a verdict (PRD CV-VERDICT-CALIBRATION-AND-GATING §6).
	// Stage A is schema-only — the disposition endpoint ships in Stage B.
	// Nested Schema (not POJO) so `reason: required` only validates when a
	// disposition is actually set, and `_id: false` applies as schema options.
	disposition: {
		type: new Schema({
			decision: { type: String, enum: ['accept', 'reject'] },
			reason: { type: String, required: true },
			by: { _id: String, username: String },
			at: Date
		}, { _id: false }),
		default: undefined
	},

	// Lifecycle
	status: { type: String, enum: ['queued', 'running', 'completed', 'failed'], default: 'queued' },
	processingTimeMs: Number,
	errorMessage: String,

	// Provenance
	triggeredBy: { type: String, enum: ['auto-on-capture', 'manual', 'batch'], default: 'auto-on-capture' },
	triggeredAt: { type: Date, default: Date.now },
	completedAt: Date
}, { timestamps: true });

cvInspectionSchema.index({ status: 1 });
cvInspectionSchema.index({ projectId: 1, modelVersion: 1 });

export const CvInspection = mongoose.models.CvInspection || mongoose.model('CvInspection', cvInspectionSchema, 'cv_inspections');
