import mongoose, { Schema } from 'mongoose';

/**
 * Robot arm — recording clean-up drafts (Clean-up tab).
 *
 * One draft per clean-up of a Pi recording. The raw commanded positions are
 * copied in once (`rawT` / `rawGoal`), so the editor keeps working when the
 * source is deleted from the Pi or the Pi is offline. `steps` is the
 * operator's edited version; nothing in it is computed after the first split
 * except by the operator (see src/lib/robot-arm/recording-cleanup.ts).
 *
 * Saving to the Pi writes a NEW recording and appends to `savedAs`; the
 * source recording is never touched.
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const moveSchema = new Schema(
	{
		servoId: { type: Number, required: true },
		to: { type: Number, required: true },
		raw: { type: new Schema({ from: Number, to: Number }, { _id: false }), default: null }
	},
	{ _id: false }
);

const stepSchema = new Schema(
	{
		id: { type: String, required: true },
		label: { type: String, default: '' },
		durationS: { type: Number, required: true },
		pauseAfterS: { type: Number, default: 0 },
		raw: { type: new Schema({ tStart: Number, tEnd: Number }, { _id: false }), default: null },
		moves: { type: [moveSchema], default: [] }
	},
	// `id` is a real field here (the editor's step id), not Mongoose's virtual.
	{ _id: false, id: false }
);

const robotArmRecordingCleanupSchema = new Schema(
	{
		_id: { type: String, required: true },
		title: { type: String, default: '' },
		status: { type: String, enum: ['draft', 'archived'], default: 'draft' },
		sourceName: { type: String, required: true },
		sourceModified: { type: String, default: null },
		sourceSizeBytes: { type: Number, default: null },
		/** The source's header line as recorded (neutrals, limits, scale). */
		sourceHeader: { type: Schema.Types.Mixed, default: null },
		rateHz: { type: Number, default: 30 },
		jointNames: { type: [String], default: [] },
		/** Raw frame times (s) and commanded goals [servo 1..6] per frame. */
		rawT: { type: [Number], default: [] },
		rawGoal: { type: [[Number]], default: [] },
		/** Split settings the steps were first detected with. */
		thresholdSteps: { type: Number, required: true },
		pauseS: { type: Number, required: true },
		start: { type: Map, of: Number, default: {} },
		steps: { type: [stepSchema], default: [] },
		savedAs: {
			type: [new Schema({ name: String, at: Date, by: operatorRef, frames: Number, durationS: Number }, { _id: false })],
			default: []
		},
		/** Move sets made from this draft for the Animate tab (robot_arm_move_sets). The draft itself is not changed. */
		moveSets: {
			type: [new Schema({ moveSetId: String, name: String, at: Date, by: operatorRef, poses: Number, keyframes: Number }, { _id: false })],
			default: []
		},
		/**
		 * Set when rawT/rawGoal are an OVERLAY (src/lib/robot-arm/recording-overlay.ts): the animated
		 * recording `sourceName` with the positions of the pilot's recording `preciseName` laid over it,
		 * with the settings it was made with. Null for a clean-up of a recording as recorded.
		 */
		overlay: {
			type: new Schema(
				{
					preciseName: { type: String, required: true },
					/** 'stretch' (uniform time scaling) or 'follow' (dynamic time warping); absent on overlays made before 2026-10-22's stretch. */
					align: { type: String, default: 'follow' },
					trimIdle: { type: Boolean, default: false },
					strength: Number,
					windowS: Number,
					servos: { type: [Number], default: [] },
					maxOffset: Number,
					fit: Number
				},
				{ _id: false }
			),
			default: null
		},
		createdBy: { type: operatorRef },
		updatedBy: { type: operatorRef }
	},
	{ timestamps: true, minimize: false }
);

export const RobotArmRecordingCleanup =
	mongoose.models.RobotArmRecordingCleanup ||
	mongoose.model('RobotArmRecordingCleanup', robotArmRecordingCleanupSchema, 'robot_arm_recording_cleanups');
