import mongoose, { Schema } from 'mongoose';

/**
 * Robot arm — a verified run (ARM-09): a move set, sequence or single pose
 * played step by step, each verified step checked by the camera and the
 * encoders against the pose's reference before the next chunk plays.
 *
 * The run is driven by the browser one request at a time (play a chunk →
 * wait for the Pi → verify → next), so every request fits Vercel's budget;
 * this document is the state between requests and the record afterwards:
 * what each check saw, and where and why the run stopped.
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const tolerancesSchema = new Schema({ positionMm: Number, angleDeg: Number, steps: Number }, { _id: false });

const stepSchema = new Schema(
	{
		index: { type: Number, required: true },
		/** '' on a fire step. */
		poseId: { type: String, default: '' },
		name: { type: String, required: true },
		/** The absolute goals the arm is sent (pose + offsets + trim, as resolved). */
		positions: { type: [Number], required: true },
		/** Where the arm should end up (pose + offsets) when positions carry a trim. */
		target: { type: [Number], default: undefined },
		holdS: { type: Number, default: 0 },
		durationS: { type: Number, default: 1 },
		easing: { type: String, default: 'ease' },
		settle: { type: Boolean, default: undefined },
		/** Checked by the camera when this step is reached. */
		verify: { type: Boolean, required: true },
		calibrationId: { type: String, default: null },
		tolerances: { type: tolerancesSchema, default: null },
		/** A fire step (cartridge trapdoor): never verified, fired inside its chunk's play. */
		fire: { type: new Schema({ solenoid: String, pulseMs: Number }, { _id: false }), default: undefined }
	},
	{ _id: false }
);

const chunkSchema = new Schema({ from: Number, to: Number, verifyStep: { type: Number, default: null } }, { _id: false });

const playSchema = new Schema(
	{
		chunk: Number,
		runId: String,
		startedAt: Date,
		durationS: Number,
		leadInS: Number,
		frames: Number,
		endedAt: { type: Date, default: null }
	},
	{ _id: false }
);

const markerSchema = new Schema(
	{ markerId: String, tagId: Number, name: String, role: String, status: String, offMm: Number, offDeg: Number, offTiltDeg: Number, ambiguous: Boolean },
	{ _id: false }
);

const resultSchema = new Schema(
	{
		step: { type: Number, required: true },
		at: { type: Date, required: true },
		verdict: { type: String, required: true },
		passed: { type: Boolean, required: true },
		residuals: { type: Map, of: Number, default: undefined },
		residualMax: { type: Number, default: null },
		visionVerdict: { type: String, default: null },
		cameraShiftMm: { type: Number, default: null },
		markers: { type: [markerSchema], default: [] },
		tolerances: { type: tolerancesSchema, default: null },
		/** What the camera saw at the check (~480 px). */
		snapshotDataUrl: { type: String, default: null },
		message: { type: String, default: '' },
		warnings: { type: [String], default: [] },
		elapsedMs: { type: Number, default: null }
	},
	{ _id: false }
);

const robotArmVerifiedRunSchema = new Schema(
	{
		_id: { type: String, required: true },
		kind: { type: String, enum: ['move_set', 'sequence', 'pose'], required: true },
		sourceId: { type: String, required: true },
		name: { type: String, required: true },
		cameraName: { type: String, required: true },
		status: { type: String, enum: ['running', 'passed', 'failed', 'stopped', 'error'], default: 'running' },
		startedAt: { type: Date, required: true },
		startedBy: { type: operatorRef },
		endedAt: { type: Date, default: null },
		rateHz: { type: Number, default: 30 },
		steps: { type: [stepSchema], default: [] },
		chunks: { type: [chunkSchema], default: [] },
		cursor: {
			chunk: { type: Number, default: 0 },
			phase: { type: String, enum: ['play', 'playing', 'verify', 'done'], default: 'play' }
		},
		plays: { type: [playSchema], default: [] },
		results: { type: [resultSchema], default: [] },
		failure: {
			type: new Schema({ step: Number, verdict: String, message: String }, { _id: false }),
			default: null
		},
		warnings: { type: [String], default: [] },
		error: { type: String, default: null }
	},
	{ timestamps: true, minimize: false }
);

robotArmVerifiedRunSchema.index({ status: 1, startedAt: -1 });
robotArmVerifiedRunSchema.index({ sourceId: 1, startedAt: -1 });

export const RobotArmVerifiedRun =
	mongoose.models.RobotArmVerifiedRun || mongoose.model('RobotArmVerifiedRun', robotArmVerifiedRunSchema, 'robot_arm_verified_runs');
