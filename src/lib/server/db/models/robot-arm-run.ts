import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applySacredMiddleware } from '../middleware/sacred.js';

// Event subdoc — no _id, append-only timeline.
const eventSubSchema = new Schema(
	{
		at: { type: Date, required: true },
		type: { type: String, required: true },
		payload: Schema.Types.Mixed
	},
	{ _id: false }
);

const robotArmRunSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		// Mirrors robot-arm-side run_id from the FastAPI server.
		runId: { type: String, required: true, unique: true, index: true },
		type: {
			type: String,
			enum: ['teleop', 'record', 'replay', 'calibrate'],
			required: true
		},
		status: {
			type: String,
			enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
			default: 'pending',
			index: true
		},
		triggeredBy: { _id: String, username: String },
		startedAt: Date,
		endedAt: Date,
		lotId: { type: String, index: true },
		// Mode-specific parameters (loosely typed by design — the run.type narrows it).
		parameters: Schema.Types.Mixed,
		result: Schema.Types.Mixed,
		events: { type: [eventSubSchema], default: [] },
		// Set when the run reaches a terminal state. Once set, sacred middleware
		// blocks further mutations.
		finalizedAt: Date
	},
	{ timestamps: true }
);

robotArmRunSchema.index({ status: 1, createdAt: -1 });
robotArmRunSchema.index({ type: 1, createdAt: -1 });

applySacredMiddleware(robotArmRunSchema, 'finalizedAt');

export const RobotArmRun =
	mongoose.models.RobotArmRun ||
	mongoose.model('RobotArmRun', robotArmRunSchema, 'robot_arm_runs');
