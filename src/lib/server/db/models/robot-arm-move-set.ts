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
		easing: { type: String, enum: ['ease', 'linear', 'in', 'out', 'flow'], default: 'ease' }
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
		lastPlay: { at: Date, by: operatorRef, runId: String, durationS: Number },
		archivedAt: { type: Date, default: null }
	},
	{ timestamps: true, minimize: false }
);

robotArmMoveSetSchema.index({ archivedAt: 1, name: 1 });

export const RobotArmMoveSet = mongoose.models.RobotArmMoveSet || mongoose.model('RobotArmMoveSet', robotArmMoveSetSchema, 'robot_arm_move_sets');
