import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * ArmWaxFillRun — one operator-requested loop of N single-cart cycles on the
 * robot-arm wax fill line. Each cycle is grab → scan → fill → withdraw; the
 * browser drives the steps one page action at a time (as the Animate verified
 * run does) and every step's ids land here, so a reload resumes where the
 * cycle was and the loop is queryable against the arm runs, the scanner sweep
 * and the WaxFillingRun it produced.
 *
 * A scan that fails (nothing read, or the cart is not a backed cart) takes the
 * FAIL ROUTE instead of failing the loop where it stands: the cycle goes to
 * step 'fail', the arm plays the fail animation, and the loop ends failed.
 * `failedStep` records which step sent it there (only 'scan' today; more fail
 * modes will add theirs).
 */
export const ARM_WAX_FILL_STEPS = ['grab', 'scan', 'decide', 'fill', 'withdraw', 'done'] as const;
export type ArmWaxFillStep = (typeof ARM_WAX_FILL_STEPS)[number];

const animationRefSchema = new Schema(
	{ kind: { type: String, enum: ['move_set', 'sequence'], required: true }, id: { type: String, required: true }, name: String },
	{ _id: false }
);

const cycleSchema = new Schema(
	{
		index: { type: Number, required: true }, // 1-based
		step: { type: String, enum: [...ARM_WAX_FILL_STEPS, 'fail', 'failed', 'stopped'], default: 'grab' },
		startedAt: Date,
		endedAt: Date,
		grabArmRunId: String,
		sweepRunId: String,
		barcode: String,
		waxRunId: String,
		opentronsRunId: String,
		opentronsRunFinalStatus: String,
		withdrawArmRunId: String,
		/** Fail route: the step that failed ('scan' / 'decide') and the arm run of the fail animation. */
		failedStep: String,
		failArmRunId: String,
		/**
		 * ARM-WAX-LOOP-B: the instruction seqs this cycle sent the protocol (scan / fill /
		 * skip), and when the protocol answered.
		 */
		scanSeq: Number,
		fillSeq: Number,
		skipSeq: Number,
		scanReadAt: Date,
		filledAt: Date,
		/**
		 * When the OT-2 reported its gantry home before each arm move. cycleGrab /
		 * cycleWithdraw / cycleFail refuse to play the arm without a fresh stamp,
		 * so the arm never swings in over a gantry that is still out on the deck.
		 */
		gantryHomedForGrabAt: Date,
		gantryHomedForWithdrawAt: Date,
		gantryHomedForFailAt: Date,
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
		failAnimation: animationRefSchema,
		cycles: { type: [cycleSchema], default: [] },
		/**
		 * ARM-WAX-LOOP-B: ONE WaxFillingRun + ONE OT-2 run serve the whole loop. The
		 * protocol parks its tip in the wax between carts and pauses; BIMS steers it
		 * through the instruction file (seq + the record last written) and resumes it.
		 */
		waxRunId: String,
		opentronsRunId: String,
		instructionSeq: { type: Number, default: 0 },
		pendingInstruction: { seq: Number, loop: String, cart: Number, action: String, barcode: String },
		/** The 'end' instruction went out: the run is finishing (tip to the trash, home). */
		ending: { type: Boolean, default: false },
		/** The run's end was recorded on the wax run (loopFinish / halt). */
		runFinished: { type: Boolean, default: false },
		opentronsRunFinalStatus: String,
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
