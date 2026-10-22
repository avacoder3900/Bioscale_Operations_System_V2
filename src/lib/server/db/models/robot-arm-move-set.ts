import mongoose, { Schema } from 'mongoose';

/**
 * Robot arm — a move set (ARM-06 Animate): an ordered list of saved poses
 * with, per pose, how long to hold it and how to arrive at it (duration and
 * easing, like After Effects keyframes). The dense path is computed from
 * this at play time (src/lib/robot-arm/animation.ts), never stored.
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const keyframeSchema = new Schema(
	{
		poseId: { type: String, required: true },
		holdS: { type: Number, default: 0 },
		durationS: { type: Number, default: 1 },
		easing: { type: String, enum: ['ease', 'linear', 'in', 'out', 'flow'], default: 'ease' },
		/** Per-servo steps on top of the pose for this keyframe only (timeline edits). */
		offsets: { type: [Number], default: undefined },
		/**
		 * ARM-09: camera check at this step in a verified run. true = must be
		 * checked (the run refuses to start without a reference), false = never,
		 * absent = checked when the pose has a reference for the camera.
		 */
		verify: { type: Boolean, default: undefined },
		/** ARM-09: this step's tolerances on top of the pose reference's (absent fields keep the reference's). */
		tolerances: { type: new Schema({ positionMm: Number, angleDeg: Number, steps: Number }, { _id: false }), default: undefined }
	},
	{ _id: false }
);

const robotArmMoveSetSchema = new Schema(
	{
		_id: { type: String, required: true },
		name: { type: String, required: true, trim: true },
		notes: { type: String, default: null },
		keyframes: { type: [keyframeSchema], default: [] },
		rateHz: { type: Number, default: 30 },
		createdBy: { type: operatorRef },
		updatedBy: { type: operatorRef },
		lastPlay: {
			at: Date,
			by: operatorRef,
			runId: String,
			durationS: Number,
			/** Where the play leaves the arm (last keyframe, without droop trim) — settleAfterPlay. */
			end: { poseId: String, target: { type: [Number], default: undefined } },
			settledAt: { type: Date, default: null }
		},
		archivedAt: { type: Date, default: null }
	},
	{ timestamps: true, minimize: false }
);

robotArmMoveSetSchema.index({ archivedAt: 1, name: 1 });

export const RobotArmMoveSet = mongoose.models.RobotArmMoveSet || mongoose.model('RobotArmMoveSet', robotArmMoveSetSchema, 'robot_arm_move_sets');
