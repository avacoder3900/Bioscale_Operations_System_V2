import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

/**
 * Robot arm test runs (2026-11-06): one row each time a Maintenance test is
 * run against the real arm, with what it measured. The Test Log on the Tests
 * page reads this. Keys are the catalog's (test.bus_echo, …) in
 * $lib/robot-arm/arm-tests. Immutable, no TTL.
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const robotArmTestRunSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		at: { type: Date, required: true, default: () => new Date() },
		key: { type: String, required: true },
		title: { type: String, required: true },
		hardware: { type: String, required: true },
		status: { type: String, enum: ['pass', 'fail', 'skipped', 'error'], required: true },
		/** One line: the judge's message, or why it was skipped / what broke. */
		message: { type: String, default: '' },
		expected: { type: String, default: '' },
		measured: { type: Schema.Types.Mixed, default: null },
		durationMs: { type: Number, default: null },
		ranBy: { type: operatorRef, default: null }
	},
	{ timestamps: false, minimize: false, collection: 'robot_arm_test_runs' }
);

robotArmTestRunSchema.index({ at: -1 });
robotArmTestRunSchema.index({ key: 1, at: -1 });

applyImmutableMiddleware(robotArmTestRunSchema);

export const RobotArmTestRun = mongoose.models.RobotArmTestRun || mongoose.model('RobotArmTestRun', robotArmTestRunSchema, 'robot_arm_test_runs');
