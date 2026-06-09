import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const robotArmSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		role: { type: String, enum: ['leader', 'follower'], required: true, unique: true },
		serialNumber: { type: String, required: true, unique: true },
		comPort: String,
		modelName: { type: String, default: 'so-arm-101' },
		voltage: { type: Number, default: 12 },
		controllerChip: { type: String, default: 'CH343' },
		firmwareVersion: String,
		registeredBy: { _id: String, username: String },
		notes: String,
		isActive: { type: Boolean, default: true }
	},
	{ timestamps: true }
);

robotArmSchema.index({ role: 1 });
robotArmSchema.index({ serialNumber: 1 });

export const RobotArm =
	mongoose.models.RobotArm || mongoose.model('RobotArm', robotArmSchema, 'robot_arms');
