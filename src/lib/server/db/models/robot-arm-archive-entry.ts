import mongoose, { Schema } from 'mongoose';

/**
 * RobotArmArchiveEntry — the list of what is in the Robot Arm R2 trash
 * (2026-11-04). Archiving an item uploads it to R2 (verified by reading it
 * back), writes one of these rows and removes the item from its own
 * collection; restoring puts it back from R2. 30 days after archiving the
 * daily cron deletes the R2 object and sets purgedAt — rows are rewritten,
 * never deleted. `meta` holds only what the archived lists show (name and a
 * few small fields), never the item itself; that lives in R2.
 */
const operatorRef = new Schema({ _id: String, username: String }, { _id: false });

const robotArmArchiveEntrySchema = new Schema(
	{
		_id: { type: String, required: true },
		kind: {
			type: String,
			enum: ['pose', 'move_set', 'sequence', 'pose_calibration', 'tag_calibration', 'camera_preset', 'cleanup'],
			required: true
		},
		itemId: { type: String, required: true },
		name: { type: String, default: '' },
		r2Key: { type: String, required: true },
		sizeBytes: { type: Number, default: 0 },
		meta: { type: Schema.Types.Mixed, default: {} },
		archivedAt: { type: Date, required: true },
		archivedBy: { type: operatorRef, default: null },
		expiresAt: { type: Date, required: true },
		restoredAt: { type: Date, default: null },
		restoredBy: { type: operatorRef, default: null },
		purgedAt: { type: Date, default: null }
	},
	{ timestamps: true, minimize: false }
);

export const RobotArmArchiveEntry =
	mongoose.models.RobotArmArchiveEntry ||
	mongoose.model('RobotArmArchiveEntry', robotArmArchiveEntrySchema, 'robot_arm_archive_entries');
