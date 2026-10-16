import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

// 30-day trash for robot-arm recordings deleted from the Pi. The files live in
// R2 at r2Key (one JSON object: {name, jsonl, meta}); this row is the index the
// Recover list reads. Rows are never deleted by users — only the daily
// purge-deleted-recordings cron removes them (and their R2 object) once
// expiresAt passes. Recovered rows keep recoveredAt and stay until then too.
const robotArmDeletedRecordingSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		name: { type: String, required: true },
		r2Key: { type: String, required: true, unique: true },
		sizeBytes: Number,
		modified: String,
		meta: { type: Schema.Types.Mixed, default: null },
		deletedBy: { _id: String, username: String },
		deletedAt: { type: Date, required: true },
		expiresAt: { type: Date, required: true, index: true },
		recoveredAt: { type: Date, default: null },
		recoveredBy: { _id: String, username: String },
		recoveredAs: String
	},
	{ timestamps: true }
);

export const RobotArmDeletedRecording =
	mongoose.models.RobotArmDeletedRecording ||
	mongoose.model(
		'RobotArmDeletedRecording',
		robotArmDeletedRecordingSchema,
		'robot_arm_deleted_recordings'
	);
