import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

/**
 * Robot arm change log (2026-11-06): one row per change to the arm, its Pi
 * or its settings, read by the Maintenance page. Labels per
 * $lib/robot-arm/change-labels: page + hardware (vague), key + target +
 * old / new + unit (precise). Immutable, no TTL — the OT-2 keeps the same
 * kind of record in audit_log for ever, and so does this.
 *
 * Tests write here too (source 'test', key test.<name>) beside their own
 * robot_arm_test_runs row, so the Change Log shows when the arm was checked.
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const robotArmChangeSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		at: { type: Date, required: true, default: () => new Date() },
		page: { type: String, required: true },
		hardware: { type: String, required: true },
		key: { type: String, required: true },
		target: { type: String, default: null },
		oldValue: { type: Schema.Types.Mixed, default: null },
		newValue: { type: Schema.Types.Mixed, default: null },
		unit: { type: String, default: null },
		source: { type: String, enum: ['ui', 'pi', 'code', 'hand', 'test'], required: true },
		/** The precise label on one line, as changeLine() prints it. */
		line: { type: String, required: true },
		/** Free text when a line is not enough (what was done by hand, a Pi file, a commit). */
		note: { type: String, default: null },
		details: { type: Schema.Types.Mixed, default: null },
		changedBy: { type: operatorRef, default: null }
	},
	{ timestamps: false, minimize: false, collection: 'robot_arm_changes' }
);

robotArmChangeSchema.index({ at: -1 });
robotArmChangeSchema.index({ key: 1, target: 1, at: -1 });
robotArmChangeSchema.index({ hardware: 1, at: -1 });

applyImmutableMiddleware(robotArmChangeSchema);

export const RobotArmChange = mongoose.models.RobotArmChange || mongoose.model('RobotArmChange', robotArmChangeSchema, 'robot_arm_changes');
