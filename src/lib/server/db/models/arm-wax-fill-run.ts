import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * ArmWaxFillRun — one operator-requested loop of N single-cart cycles on the
 * robot-arm wax fill line. Each cycle is grab → scan → fill → withdraw; the
 * browser drives the steps one page action at a time (as the Animate verified
 * run does) and every step's ids land here, so a reload resumes where the
 * cycle was and the loop is queryable against the arm runs, the scanner sweep
 * and the WaxFillingRun it produced.
 */
export const ARM_WAX_FILL_STEPS = ['grab', 'scan', 'fill', 'withdraw', 'done'] as const;
export type ArmWaxFillStep = (typeof ARM_WAX_FILL_STEPS)[number];

const animationRefSchema = new Schema(
	{ kind: { type: String, enum: ['move_set', 'sequence'], required: true }, id: { type: String, required: true }, name: String },
	{ _id: false }
);

const cycleSchema = new Schema(
	{
		index: { type: Number, required: true }, // 1-based
		step: { type: String, enum: [...ARM_WAX_FILL_STEPS, 'failed', 'stopped'], default: 'grab' },
		startedAt: Date,
		endedAt: Date,
		grabArmRunId: String,
		sweepRunId: String,
		barcode: String,
		waxRunId: String,
		opentronsRunId: String,
		opentronsRunFinalStatus: String,
		withdrawArmRunId: String,
		error: String
	},
	{ _id: false }
);

const armWaxFillRunSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		robot: { _id: String, name: String },
		cartPosition: Number,
		requestedRuns: { type: Number, required: true },
		completedRuns: { type: Number, default: 0 },
		status: { type: String, enum: ['running', 'completed', 'stopped', 'failed'], default: 'running', index: true },
		stopRequested: { type: Boolean, default: false },
		grabAnimation: animationRefSchema,
		withdrawAnimation: animationRefSchema,
		cycles: { type: [cycleSchema], default: [] },
		error: String,
		startedBy: { _id: String, username: String },
		startedAt: Date,
		endedAt: Date
	},
	{ timestamps: true }
);

armWaxFillRunSchema.index({ status: 1, createdAt: -1 });

export const ArmWaxFillRun =
	mongoose.models.ArmWaxFillRun || mongoose.model('ArmWaxFillRun', armWaxFillRunSchema, 'arm_wax_fill_runs');
