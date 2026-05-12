import mongoose, { Schema } from 'mongoose';

const robotArmRunSchema = new Schema(
	{
		_id: { type: String, required: true },
		type: { type: String, enum: ['teleop', 'record', 'replay', 'calibrate'] },
		status: {
			type: String,
			enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
			default: 'running'
		},
		triggeredBy: {
			_id: String,
			username: String
		},
		startedAt: Date,
		endedAt: Date,
		lotId: String,
		parameters: Schema.Types.Mixed,
		result: Schema.Types.Mixed,
		events: [
			{
				_id: false,
				at: Date,
				type: String,
				payload: Schema.Types.Mixed
			}
		],
		firstSeenAt: { type: Date, default: () => new Date() },
		lastEventAt: Date
	},
	{ timestamps: true }
);

robotArmRunSchema.index({ status: 1, startedAt: -1 });
robotArmRunSchema.index({ type: 1, startedAt: -1 });

export const RobotArmRun =
	mongoose.models.RobotArmRun ||
	mongoose.model('RobotArmRun', robotArmRunSchema, 'robot_arm_runs');
