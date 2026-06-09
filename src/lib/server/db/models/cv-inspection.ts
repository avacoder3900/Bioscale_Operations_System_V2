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
	anomalyScore: Number,
	confidenceThreshold: Number,
	defects: [{ type: String, location: String, severity: String, _id: false }],

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
