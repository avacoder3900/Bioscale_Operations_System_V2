import mongoose, { Schema } from 'mongoose';

/**
 * Robot arm — a saved pose (ARM-06 Animate).
 *
 * Set with the live sliders (each slider drives one servo on the real arm),
 * or captured from the follower while it follows the control arm. Reused
 * across move sets by id; archived rather than deleted, so a move set that
 * references it keeps working. Only an archived pose no move set uses can be
 * deleted for good (deleteArchivedPoses; the audit entry keeps a copy).
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const robotArmPoseSchema = new Schema(
	{
		_id: { type: String, required: true },
		name: { type: String, required: true, trim: true },
		/** Encoder steps, servo ids 1..6 at index 0..5. */
		positions: { type: [Number], required: true },
		/**
		 * What `positions` are (2026-10-22 redo):
		 *   goal    — the goals the operator set with the live sliders. Played
		 *             back exactly; the arm lands where it sat while being posed
		 *             (same goal, same sag). No droop trim, no settling.
		 *   reading — encoder readings (control-arm capture, older poses). The
		 *             arm sits a droop short of a reading when it is used as a
		 *             goal, so these keep the trim / settle machinery below.
		 * Missing = reading (every pose saved before the redo).
		 */
		basis: { type: String, enum: ['goal', 'reading'], default: 'reading' },
		/**
		 * Droop trim: steps added to the goal when this pose is played, so the
		 * arm ARRIVES at `positions` under gravity instead of settling short of
		 * it. Learned automatically on the arm (settleAtPose, at the end of Go to
		 * pose and of every Play); empty = not learned yet (an estimate is used).
		 */
		trim: { type: [Number], default: undefined },
		trimMeasuredAt: { type: Date, default: null },
		trimMeasuredBy: { type: operatorRef, default: null },
		notes: { type: String, default: null },
		createdBy: { type: operatorRef },
		/** The last Go to pose (played like a one-pose move set); afterPlay finds it by runId. */
		lastPlay: {
			at: Date,
			by: operatorRef,
			runId: String,
			durationS: Number,
			end: { poseId: String, target: { type: [Number], default: undefined } },
			settledAt: { type: Date, default: null }
		},
		archivedAt: { type: Date, default: null }
	},
	{ timestamps: true }
);

robotArmPoseSchema.index({ archivedAt: 1, name: 1 });

export const RobotArmPose = mongoose.models.RobotArmPose || mongoose.model('RobotArmPose', robotArmPoseSchema, 'robot_arm_poses');
