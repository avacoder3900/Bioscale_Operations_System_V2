import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

/**
 * Robot arm Movement Log (2026-11-06): one row per command BIMS sent that
 * moves the arm — each servo move or jog, and each whole-arm command (hold,
 * Cartesian jog, torque, play, leader arm, task, Stop). Written by
 * robotArmFetch via $lib/server/robot-arm-move-log; shapes in
 * $lib/robot-arm/move-log. Kept so "it kept going back and forth an hour
 * ago" can be checked. Immutable, no TTL, like the Change Log.
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const robotArmMoveSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		at: { type: Date, required: true, default: () => new Date() },
		kind: { type: String, required: true },
		servo: { type: Number, default: null },
		goal: { type: Number, default: null },
		delta: { type: Number, default: null },
		goals: { type: Schema.Types.Mixed, default: null },
		what: { type: String, default: null },
		line: { type: String, required: true },
		/** False when the Pi refused or did not answer. */
		ok: { type: Boolean, required: true },
		error: { type: String, default: null },
		durationMs: { type: Number, default: null },
		/** The BIMS page or route that sent it. */
		from: { type: String, default: null },
		movedBy: { type: operatorRef, default: null }
	},
	{ timestamps: false, minimize: false, collection: 'robot_arm_moves' }
);

robotArmMoveSchema.index({ at: -1 });
robotArmMoveSchema.index({ servo: 1, at: -1 });

applyImmutableMiddleware(robotArmMoveSchema);

export const RobotArmMove = mongoose.models.RobotArmMove || mongoose.model('RobotArmMove', robotArmMoveSchema, 'robot_arm_moves');
