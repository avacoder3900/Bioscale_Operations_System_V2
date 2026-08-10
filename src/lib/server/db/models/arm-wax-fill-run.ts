import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applySacredMiddleware } from '../middleware/sacred.js';

/**
 * ARM-WAX-01 — one coordinated "arm loads cartridge → OT-2 fills wax →
 * arm unloads" cycle for a SINGLE cartridge.
 *
 * The run is a state machine whose transitions are guarded server-side
 * (src/lib/server/arm-wax-fill.ts). The `deckToken` records who is allowed
 * to move over/near the nest right now — the whole interlock reduces to
 * "the arm and the OT-2 gantry never hold the token at the same time".
 *
 * Phases:
 *   created        — run configured, nothing moving           (token: none)
 *   arm_loading    — arm replay task placing the cartridge    (token: arm)
 *   loaded         — arm parked+confirmed, cartridge seated   (token: none)
 *   ot2_filling    — OT-2 run playing                         (token: ot2)
 *   filled         — OT-2 run succeeded, gantry homed         (token: none)
 *   arm_unloading  — arm replay task removing the cartridge   (token: arm)
 *   complete       — cartridge out, cart status → wax_filled  (terminal)
 *   failed         — any step errored                         (terminal)
 *   aborted        — operator abort                           (terminal)
 */

export const ARM_WAX_PHASES = [
	'created',
	'arm_loading',
	'loaded',
	'ot2_filling',
	'filled',
	'arm_unloading',
	'complete',
	'failed',
	'aborted'
] as const;
export type ArmWaxPhase = (typeof ARM_WAX_PHASES)[number];

export const TERMINAL_PHASES: ArmWaxPhase[] = ['complete', 'failed', 'aborted'];

/** Who owns the airspace over the nest in each phase. */
export const DECK_TOKEN: Record<ArmWaxPhase, 'none' | 'arm' | 'ot2'> = {
	created: 'none',
	arm_loading: 'arm',
	loaded: 'none',
	ot2_filling: 'ot2',
	filled: 'none',
	arm_unloading: 'arm',
	complete: 'none',
	failed: 'none',
	aborted: 'none'
};

/** Legal forward transitions (abort/fail are allowed from any non-terminal phase). */
export const NEXT_PHASE: Partial<Record<ArmWaxPhase, ArmWaxPhase>> = {
	created: 'arm_loading',
	arm_loading: 'loaded',
	loaded: 'ot2_filling',
	ot2_filling: 'filled',
	filled: 'arm_unloading',
	arm_unloading: 'complete'
};

const eventSubSchema = new Schema(
	{
		at: { type: Date, required: true },
		type: { type: String, required: true },
		phase: String,
		by: String, // username or 'agent'
		payload: Schema.Types.Mixed
	},
	{ _id: false }
);

const armWaxFillRunSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		phase: { type: String, enum: ARM_WAX_PHASES, default: 'created', index: true },

		// What we are filling.
		cartridgeId: { type: String, required: true, index: true },

		// Which OT-2 (OpentronsRobot._id) does the filling.
		robotId: { type: String, required: true },

		// Nest / protocol parameters captured at creation so the run is
		// reproducible even if defaults change later.
		parameters: {
			nestSlot: { type: String, default: '1' },
			waxTubeWell: { type: String, default: 'A1' },
			channels: {
				a: { type: Boolean, default: true },
				b: { type: Boolean, default: true },
				c: { type: Boolean, default: true }
			},
			volumes: {
				gate4: { type: Number, default: 1.6 },
				gate3: { type: Number, default: 1.6 },
				gate2: { type: Number, default: 1.6 },
				gate1: { type: Number, default: 1.6 }
			},
			aspirateRemainder: { type: Number, default: 11.5 },
			dryRun: { type: Boolean, default: false }
		},

		// Cross-references into the machines' own run records.
		armLoadRunId: String, // RobotArmRun.runId of the load replay task
		armUnloadRunId: String, // RobotArmRun.runId of the unload replay task
		ot2ProtocolId: String, // protocol id on the OT-2
		ot2RunId: String, // run id on the OT-2

		// Interlock verification stamps — set by the guarded transitions.
		armParkedVerifiedAt: Date, // arm reported parked & session inactive
		ot2HomedVerifiedAt: Date, // OT-2 run terminal + gantry homed

		error: String,
		events: { type: [eventSubSchema], default: [] },

		triggeredBy: { _id: String, username: String },
		startedAt: Date,
		endedAt: Date,
		// Stamped when the run reaches a terminal phase; sacred middleware
		// then blocks further mutations.
		finalizedAt: Date
	},
	{ timestamps: true }
);

armWaxFillRunSchema.index({ phase: 1, createdAt: -1 });
armWaxFillRunSchema.index({ cartridgeId: 1, createdAt: -1 });

applySacredMiddleware(armWaxFillRunSchema, 'finalizedAt');

export const ArmWaxFillRun =
	mongoose.models.ArmWaxFillRun ||
	mongoose.model('ArmWaxFillRun', armWaxFillRunSchema, 'arm_wax_fill_runs');
