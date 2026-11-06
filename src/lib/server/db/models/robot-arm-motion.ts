import mongoose, { Schema } from 'mongoose';

// Who is moving the arm from BIMS right now (2026-11-06). One row, _id 'arm':
// a short lease, not a lock that can strand — it ends on its own at `until`.
// Return Home, the droop settle after a play, and the start of a Play / Go to
// pose each claim it, so two of them can never drive the arm at once (16:28
// that day: Return Home jogged the shoulder home while the settle kept sending
// it back to the pose). See $lib/server/robot-arm-motion.
const robotArmMotionSchema = new Schema(
	{
		_id: { type: String, required: true },
		/** The claim's own id (`return:<runId>`, `settle:<id>`, `play:<id>`). */
		owner: { type: String, required: true },
		/** What it is, for the "arm is busy" message. */
		label: { type: String, required: true },
		username: { type: String, default: null },
		claimedAt: { type: Date, required: true },
		/** The lease ends here unless the owner renews it. */
		until: { type: Date, required: true }
	},
	{ timestamps: false }
);

export const RobotArmMotion =
	mongoose.models.RobotArmMotion || mongoose.model('RobotArmMotion', robotArmMotionSchema, 'robot_arm_motion');
