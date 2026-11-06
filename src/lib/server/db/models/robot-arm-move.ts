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
 *
 * 2026-11-06: the OT-2 too (device 'ot2') — one row per command its run
 * executed, with the robot's own start and end ($lib/server/ot2-move-log),
 * and the arm's loop steps (kind 'loop_step', play sent → arrival checked),
 * so the two machines' timing sits on one timeline. Rows from before have no
 * device and are the arm's.
 *
 * 2026-11-06: servo readings before and after each arm move (kinds
 * reading_before / reading_after, linked by moveId), and the OT-2's home and
 * rail lights sent outside a run (kinds home, lights_on, lights_off).
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });
const robotRef = new Schema({ _id: { type: String }, name: { type: String } }, { _id: false });

const robotArmMoveSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		/** 'arm' | 'ot2'; missing on rows from before 2026-11-06 (all arm). */
		device: { type: String, default: 'arm' },
		at: { type: Date, required: true, default: () => new Date() },
		/** When it ended, for rows with a measured end (OT-2 commands, arm loop steps). */
		endAt: { type: Date, default: null },
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
		movedBy: { type: operatorRef, default: null },
		/** OT-2 rows: the robot, its run, the command's place in the run, its params. */
		robot: { type: robotRef, default: undefined },
		runId: { type: String, default: undefined },
		seq: { type: Number, default: undefined },
		commandId: { type: String, default: undefined },
		intent: { type: String, default: undefined },
		params: { type: Schema.Types.Mixed, default: undefined },
		/** Arm loop steps: the wax-fill loop and cart. */
		loopId: { type: String, default: undefined },
		cart: { type: Number, default: undefined },
		/** Reading rows (reading_before / reading_after): the servos as GET /servos gave them, and the move they bracket. */
		readings: { type: Schema.Types.Mixed, default: undefined },
		moveId: { type: String, default: undefined }
	},
	{ timestamps: false, minimize: false, collection: 'robot_arm_moves' }
);

robotArmMoveSchema.index({ at: -1 });
robotArmMoveSchema.index({ servo: 1, at: -1 });

applyImmutableMiddleware(robotArmMoveSchema);

export const RobotArmMove = mongoose.models.RobotArmMove || mongoose.model('RobotArmMove', robotArmMoveSchema, 'robot_arm_moves');
