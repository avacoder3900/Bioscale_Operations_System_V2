import mongoose, { Schema } from 'mongoose';

/**
 * Robot arm — a sequence (ARM-06 Animate): move sets played one after
 * another, with a join transition between each pair (the arm tweens from
 * the previous set's last pose to the next set's first; duration automatic
 * unless set). Saving to the Pi writes the whole rendered sequence as a
 * recording (`savedAs`), replayable from the Control tab and usable in tasks.
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const itemSchema = new Schema(
	{
		moveSetId: { type: String, required: true },
		/** null = automatic from the distance between the poses. */
		joinDurationS: { type: Number, default: null },
		joinEasing: { type: String, enum: ['ease', 'linear', 'in', 'out', 'flow'], default: 'ease' }
	},
	{ _id: false }
);

const robotArmSequenceSchema = new Schema(
	{
		_id: { type: String, required: true },
		name: { type: String, required: true, trim: true },
		notes: { type: String, default: null },
		items: { type: [itemSchema], default: [] },
		createdBy: { type: operatorRef },
		updatedBy: { type: operatorRef },
		lastPlay: { at: Date, by: operatorRef, runId: String, durationS: Number },
		savedAs: {
			type: [new Schema({ name: String, at: Date, by: operatorRef, frames: Number, durationS: Number }, { _id: false })],
			default: []
		},
		archivedAt: { type: Date, default: null }
	},
	{ timestamps: true, minimize: false }
);

robotArmSequenceSchema.index({ archivedAt: 1, name: 1 });

export const RobotArmSequence = mongoose.models.RobotArmSequence || mongoose.model('RobotArmSequence', robotArmSequenceSchema, 'robot_arm_sequences');
