import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * CvInspection — machine verdicts ONLY. One row per (photo × model version)
 * inference run. Human ground truth NEVER lives here — it lives on
 * cartridge_records.photos[].qcLabel. Review UIs compute human/machine
 * agreement by joining this collection against the photo entry by imageId.
 */
const cvInspectionSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	// What was inspected
	imageId: { type: String, index: true },
	cartridgeRecordId: { type: String, index: true },
	phase: String,

	// What inspected it
	projectId: { type: String, index: true },
	modelVersion: String,
	// True when this run came from the project's shadowModelVersion — a
	// candidate model being evaluated silently; not shown as the verdict.
	isShadow: { type: Boolean, default: false },

	// Lifecycle — one vocabulary. Created as 'running' right before inference
	// so operators can see in-flight inspections.
	status: { type: String, enum: ['running', 'completed', 'failed'], default: 'running' },
	errorMessage: String,

	// The verdict
	result: { type: String, enum: ['pass', 'fail', null], default: null },
	// Raw sigmoid output (0..1) — distance from threshold drives the review
	// queue's uncertainty sampling.
	passProbability: Number,
	confidenceScore: Number,
	threshold: Number,

	triggeredBy: { type: String, enum: ['auto-on-capture', 'manual', 'batch'], default: 'auto-on-capture' },
	triggeredAt: Date,
	processingTimeMs: Number,
	completedAt: Date
}, { timestamps: true });

cvInspectionSchema.index({ status: 1 });
cvInspectionSchema.index({ projectId: 1, result: 1 });
cvInspectionSchema.index({ phase: 1, completedAt: -1 });

export const CvInspection = mongoose.models.CvInspection || mongoose.model('CvInspection', cvInspectionSchema, 'cv_inspections');
