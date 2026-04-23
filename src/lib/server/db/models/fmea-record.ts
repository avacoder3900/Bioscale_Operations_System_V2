import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * FMEA = Failure Mode and Effects Analysis. One record per (process, failure
 * mode) pair. RPN = Severity × Occurrence × Detection, 1-10 each → 1-1000.
 * Review cadence is quarterly; changes are auto-versioned via AuditLog.
 */
const fmeaActionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	action: String,
	owner: { _id: String, username: String },
	dueDate: Date,
	completedAt: Date,
	status: { type: String, enum: ['open', 'in_progress', 'complete', 'cancelled'], default: 'open' },
	effectivenessCheck: String
}, { _id: false });

const fmeaRecordSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	processType: {
		type: String,
		enum: ['wi-01', 'laser-cut', 'cut-thermoseal', 'cut-top-seal', 'wax',
			'reagent', 'top-seal', 'qa-qc', 'storage', 'shipping', 'general'],
		required: true,
		index: true
	},
	processStep: String, // e.g. 'deck_loading', 'wax_dispense', 'cooling'
	failureMode: { type: String, required: true },
	failureEffect: String,
	severity: { type: Number, min: 1, max: 10 },
	cause: String,
	occurrence: { type: Number, min: 1, max: 10 },
	currentControls: String,
	detection: { type: Number, min: 1, max: 10 },
	rpn: { type: Number }, // auto-computed = severity * occurrence * detection
	recommendedActions: [fmeaActionSchema],
	// Classification
	classification: { type: String, enum: ['safety', 'quality', 'compliance', 'productivity', null], default: null },
	linkedRejectionCodes: [String], // ties FMEA to actual rejection codes seen
	// Review cycle
	reviewedAt: Date,
	nextReviewDue: Date,
	reviewedBy: { _id: String, username: String },
	// Status
	status: { type: String, enum: ['draft', 'active', 'archived'], default: 'draft' },
	version: { type: Number, default: 1 },
	createdBy: { _id: String, username: String }
}, { timestamps: true });

// Auto-compute RPN on save
fmeaRecordSchema.pre('save', function(this: any) {
	const s = this.severity ?? 0;
	const o = this.occurrence ?? 0;
	const d = this.detection ?? 0;
	this.rpn = s * o * d;
});

fmeaRecordSchema.index({ processType: 1, rpn: -1 });
fmeaRecordSchema.index({ status: 1, rpn: -1 });

export const FmeaRecord = mongoose.models.FmeaRecord
	|| mongoose.model('FmeaRecord', fmeaRecordSchema, 'fmea_records');
