import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

// One SPU's membership in a run. Step state is keyed by step name
// ('magnetometer' | 'thermocouple' | 'optical_confirmation') and kept as Mixed
// because cells carry step-specific payloads (thermo stats + evaluation,
// session links, manual-record notes). Cell shape:
// { status: 'not_started'|'in_progress'|'uploaded'|'passed'|'failed'|'skipped',
//   sessionId?, result?, evaluation?, completedAt?, completedBy?, notes? }
const runSpuSchema = new Schema({
	spuId: { type: String, required: true },
	udi: { type: String, required: true },
	addedAt: { type: Date, default: () => new Date() },
	removedAt: Date,
	steps: Schema.Types.Mixed
}, { _id: false });

const validationRunSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	runNumber: { type: String, required: true },
	name: String,
	status: { type: String, enum: ['in_progress', 'completed', 'aborted'], default: 'in_progress' },
	// Ordered step keys — display order only; execution order is not enforced.
	steps: [String],
	spus: [runSpuSchema],
	createdBy: operatorRef,
	startedAt: { type: Date, default: () => new Date() },
	completedAt: Date,
	abortReason: String,
	notes: String
}, { timestamps: true, minimize: false });

validationRunSchema.index({ runNumber: 1 }, { unique: true });
validationRunSchema.index({ status: 1, startedAt: -1 });
validationRunSchema.index({ 'spus.spuId': 1 });

export const ValidationRun = mongoose.models.ValidationRun || mongoose.model('ValidationRun', validationRunSchema, 'validation_runs');

export const VALIDATION_RUN_STEPS = ['magnetometer', 'thermocouple', 'optical_confirmation'] as const;
export type ValidationRunStep = (typeof VALIDATION_RUN_STEPS)[number];

export const STEP_LABELS: Record<ValidationRunStep, string> = {
	magnetometer: 'Magnetometer',
	thermocouple: 'Thermocouple',
	optical_confirmation: 'Optical Confirmation'
};
