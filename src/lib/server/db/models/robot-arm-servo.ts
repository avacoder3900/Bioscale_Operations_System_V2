import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const robotArmServoSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		armId: { type: String, required: true, ref: 'RobotArm' },
		motorId: { type: Number, required: true, min: 1, max: 6 },
		jointName: {
			type: String,
			enum: [
				'shoulder_pan',
				'shoulder_lift',
				'elbow_flex',
				'wrist_flex',
				'wrist_roll',
				'gripper'
			],
			required: true
		},
		model: { type: String, default: 'STS3215' },
		voltageRated: Number,
		gearing: String,
		minAngleLimit: Number,
		maxAngleLimit: Number,
		offset: Number,
		lastReadAt: Date
	},
	{ timestamps: true }
);

robotArmServoSchema.index({ armId: 1, motorId: 1 }, { unique: true });

export const RobotArmServo =
	mongoose.models.RobotArmServo ||
	mongoose.model('RobotArmServo', robotArmServoSchema, 'robot_arm_servos');
