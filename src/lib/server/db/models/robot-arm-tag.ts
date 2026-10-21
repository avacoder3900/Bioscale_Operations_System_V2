import mongoose, { Schema } from 'mongoose';

/**
 * Robot arm — a registered AprilTag (ARM-05). Replaces ARM-04's colour
 * sticker registry (`robot_arm_markers`, left in Mongo and no longer read).
 *
 * One row per physical tag stuck on the arm or its surroundings, from the
 * printed 36h11 sheet (services/robot-arm/calibration/apriltag-sheet.html).
 * `tagId` is what the camera decodes, so it must be unique among active rows;
 * `sizeMm` (edge of the black square, as printed or as measured) is what
 * turns a detection into millimetres. `role`:
 *   - `fixed`: never moves (deck, Opentron, frame) — used to measure and undo
 *     a camera bump;
 *   - `arm`: on the arm — what the home check is about.
 * Name and group are the operator's own.
 *
 * Archived, never deleted: a calibration may still reference the tag.
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const robotArmTagSchema = new Schema(
	{
		_id: { type: String, required: true },
		tagId: { type: Number, required: true, min: 0, max: 586 },
		sizeMm: { type: Number, required: true, min: 1, max: 500 },
		role: { type: String, enum: ['fixed', 'arm'], required: true },
		name: { type: String, required: true, trim: true },
		group: { type: String, default: null, trim: true },
		notes: { type: String, default: null },
		createdBy: { type: operatorRef },
		archivedAt: { type: Date, default: null },
		archivedBy: { type: operatorRef, default: null }
	},
	{ timestamps: true }
);

robotArmTagSchema.index({ archivedAt: 1, tagId: 1 });

export const RobotArmTag = mongoose.models.RobotArmTag || mongoose.model('RobotArmTag', robotArmTagSchema, 'robot_arm_tags');
