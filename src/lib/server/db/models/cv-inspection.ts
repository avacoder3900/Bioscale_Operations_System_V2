import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const cvInspectionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	sampleId: String,
	imageId: String,
	projectId: { type: String, index: true },
	inspectionType: String,
	// Enum matches what run-inference.ts actually writes; legacy values
	// (pending/processing/complete) are normalized by migrate-cv-pipeline-v2.ts.
	status: { type: String, enum: ['queued', 'running', 'completed', 'failed'], default: 'queued' },
	result: { type: String, enum: ['pass', 'fail', null], default: null },
	confidenceScore: Number,
	// `type` must be wrapped ({ type: String }) — a bare `type: String` here makes
	// Mongoose read the whole subdoc as "array of String", so writing a defect
	// object threw "Cast to string failed ... at path defects.0" on FAIL verdicts.
	defects: [{ type: { type: String }, location: String, severity: String, _id: false }],
	modelVersion: String,
	modelPath: String,
	processingTimeMs: Number,
	cartridgeRecordId: String,
	phase: String,
	completedAt: Date,
	// Run metadata written by run-inference.ts runOne().
	isShadow: { type: Boolean, default: false, index: true },
	triggeredBy: String,
	triggeredAt: Date,
	confidenceThreshold: Number,
	anomalyScore: Number,
	errorMessage: String,
	// Human ground-truth review of the model's verdict. Feeds the training set:
	// 'pass' -> CvImage.label 'approved', 'fail' -> 'rejected'.
	humanLabel: { type: String, enum: ['pass', 'fail', null], default: null },
	reviewedBy: { _id: String, username: String },
	reviewedAt: Date
}, { timestamps: true });

cvInspectionSchema.index({ sampleId: 1 });
cvInspectionSchema.index({ status: 1 });
cvInspectionSchema.index({ cartridgeRecordId: 1 });
cvInspectionSchema.index({ projectId: 1, humanLabel: 1 });
// Needs-review queue: model verdict present, no human review yet, non-shadow.
cvInspectionSchema.index({ result: 1, humanLabel: 1, isShadow: 1 });

export const CvInspection = mongoose.models.CvInspection || mongoose.model('CvInspection', cvInspectionSchema, 'cv_inspections');
