import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const robotArmDatasetSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		name: { type: String, required: true },
		path: { type: String, required: true, unique: true },
		recordedAt: Date,
		recordedBy: { _id: String, username: String },
		rateHz: Number,
		durationS: Number,
		frames: Number,
		jointNames: { type: [String], default: undefined },
		leaderNeutral: { type: [Number], default: undefined },
		followerNeutral: { type: [Number], default: undefined },
		followerMin: { type: [Number], default: undefined },
		followerMax: { type: [Number], default: undefined },
		// Link back to the run that produced this recording.
		sourceRunId: { type: String, index: true, ref: 'RobotArmRun' },
		hfHubUrl: String
	},
	{ timestamps: true }
);

robotArmDatasetSchema.index({ name: 1, recordedAt: -1 });

export const RobotArmDataset =
	mongoose.models.RobotArmDataset ||
	mongoose.model('RobotArmDataset', robotArmDatasetSchema, 'robot_arm_datasets');
