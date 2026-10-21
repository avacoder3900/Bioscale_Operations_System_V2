import mongoose, { Schema } from 'mongoose';

/**
 * Robot arm — a saved pose (ARM-06 Animate).
 *
 * Captured from the follower's encoders while the operator held the arm in
 * position by hand. Reused across move sets by id; archived, never deleted,
 * so a move set that references it keeps working.
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const robotArmPoseSchema = new Schema(
	{
		_id: { type: String, required: true },
		name: { type: String, required: true, trim: true },
		/** Encoder steps, servo ids 1..6 at index 0..5. */
		positions: { type: [Number], required: true },
		/**
		 * Droop trim: steps added to the goal when this pose is played, so the
		 * arm ARRIVES at `positions` under gravity instead of settling short of
		 * it. Measured on the arm (measurePoseDroop); empty = not measured.
		 */
		trim: { type: [Number], default: undefined },
		trimMeasuredAt: { type: Date, default: null },
		trimMeasuredBy: { type: operatorRef, default: null },
		notes: { type: String, default: null },
		createdBy: { type: operatorRef },
		archivedAt: { type: Date, default: null }
	},
	{ timestamps: true }
);

robotArmPoseSchema.index({ archivedAt: 1, name: 1 });

export const RobotArmPose = mongoose.models.RobotArmPose || mongoose.model('RobotArmPose', robotArmPoseSchema, 'robot_arm_poses');
