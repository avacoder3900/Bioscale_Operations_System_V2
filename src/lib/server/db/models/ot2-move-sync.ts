import mongoose, { Schema } from 'mongoose';

/**
 * How far the Movement Log has read each OT-2 run's command log (2026-11-06):
 * `cursor` is the run's index of the next command to log, `done` once the run
 * ended and every command it executed is in robot_arm_moves. One row per run
 * id. Written by $lib/server/ot2-move-log only.
 */
const ot2MoveSyncSchema = new Schema(
	{
		_id: { type: String, required: true },
		robot: { _id: { type: String }, name: { type: String } },
		cursor: { type: Number, default: 0 },
		done: { type: Boolean, default: false },
		runStatus: { type: String, default: null },
		protocolName: { type: String, default: null },
		runCreatedAt: { type: Date, default: null },
		syncedAt: { type: Date, default: null }
	},
	{ timestamps: false, minimize: false, collection: 'ot2_move_syncs' }
);

export const Ot2MoveSync = mongoose.models.Ot2MoveSync || mongoose.model('Ot2MoveSync', ot2MoveSyncSchema, 'ot2_move_syncs');
