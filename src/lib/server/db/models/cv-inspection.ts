import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const cvInspectionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	sampleId: String,
	imageId: String,
	projectId: { type: String, index: true },
	inspectionType: String,
	status: { type: String, enum: ['pending', 'processing', 'complete', 'failed'], default: 'pending' },
	result: { type: String, enum: ['pass', 'fail', null], default: null },
	confidenceScore: Number,
	defects: [{ type: String, location: String, severity: String, _id: false }],
	modelVersion: String,
	processingTimeMs: Number,
	cartridgeRecordId: String,
	phase: String,
	completedAt: Date,
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

export const CvInspection = mongoose.models.CvInspection || mongoose.model('CvInspection', cvInspectionSchema, 'cv_inspections');
