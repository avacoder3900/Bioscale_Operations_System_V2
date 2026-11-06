import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

/**
 * Robot arm unit test runs (2026-11-06): one row per run of the automated
 * arm tests (vitest, no arm needed), written by
 * scripts/report-arm-unit-tests.ts. The Tests page shows the newest as
 * "passed / total" and every run in the Test Log. Immutable, no TTL.
 */
const fileSchema = new Schema(
	{
		file: { type: String, required: true },
		total: { type: Number, required: true },
		passed: { type: Number, required: true },
		failures: { type: [String], default: [] }
	},
	{ _id: false }
);

const robotArmUnitRunSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		at: { type: Date, required: true, default: () => new Date() },
		total: { type: Number, required: true },
		passed: { type: Number, required: true },
		failed: { type: Number, required: true },
		skipped: { type: Number, default: 0 },
		durationMs: { type: Number, default: null },
		files: { type: [fileSchema], default: [] },
		branch: { type: String, default: null },
		commit: { type: String, default: null },
		ranBy: { type: String, default: null }
	},
	{ timestamps: false, minimize: false, collection: 'robot_arm_unit_runs' }
);

robotArmUnitRunSchema.index({ at: -1 });

applyImmutableMiddleware(robotArmUnitRunSchema);

export const RobotArmUnitRun = mongoose.models.RobotArmUnitRun || mongoose.model('RobotArmUnitRun', robotArmUnitRunSchema, 'robot_arm_unit_runs');
