import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * In-run service session for a wax fill (WAX-SERVICE-1).
 *
 * The OT-2 only accepts gantry motion inside a maintenance run, and a
 * maintenance run cannot be opened while a protocol run is non-terminal —
 * `openMaintenanceRun()` would in fact STOP AND DELETE the fill to free the run
 * engine (see src/lib/server/opentrons/maintenance.ts). So mid-run jogging /
 * tip changes cannot go through the maintenance stack at all.
 *
 * Instead the fill protocol itself cooperates: between wells it checks this
 * session, and when one is open it stops dispensing and starts executing
 * operator commands with its own pipette handle. The OT-2 run never stops, so
 * resuming lands on exactly the well it left off at.
 *
 * This document IS the channel:
 *   - operator UI  → POST /api/opentrons-lab/robots/:id/runs/:rid/service/command
 *                    sets `pendingCommand`
 *   - protocol     → GET  /api/agent/ot2/service/:runId  (long-poll) claims it
 *                    POST /api/agent/ot2/service/:runId  reports location/result
 *
 * NOTE this is deliberately NOT an Ot2BridgeCommand. The bridge daemon is a
 * strict single worker; holding a session open through it would stall the 2s
 * run-status polls that share that queue.
 */

/** Verbs the fill protocol knows how to execute while in service mode. */
export const SERVICE_VERBS = [
	'jog',        // args: { axis: 'x'|'y'|'z', mm: number }
	'goto_well',  // re-run the real approach to the reported well
	'change_tip', // blow out to trash, drop tip, pick up + calibrate a new one
	'tip_cal',    // re-run tip calibration on the current tip
	'resume'      // hand control back to the dispense loop
] as const;

export type ServiceVerb = (typeof SERVICE_VERBS)[number];

const ot2ServiceSessionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	opentronsRunId: String,       // the OT-2 run UUID this session rides on
	robotId: String,              // OpentronsRobot._id
	processType: { type: String, default: 'wax-filling' },

	// requested → the operator asked; the protocol has not reached a checkpoint yet
	// active    → the protocol is parked in its service loop and taking commands
	// closed    → resumed, aborted, or the run ended
	status: {
		type: String,
		enum: ['requested', 'active', 'closed'],
		default: 'requested'
	},

	// Where the protocol was when it entered service mode — this is what the
	// operator is shown, and what `goto_well` rewinds to.
	location: {
		_id: false,
		wellName: String,         // e.g. 'B7'
		volumeUl: Number,         // volume it was dispensing there
		tipNumber: Number,        // tip_change_count at that point
		adjustX: Number,          // tip-cal offset in force at that point
		adjustY: Number,
		reportedAt: Date
	},

	// At most one command is outstanding at a time — the protocol executes
	// strictly one verb before asking for the next.
	//
	// `deliveredAt` is set when the long-poll hands the command to the protocol.
	// A delivered-but-unanswered command is NEVER handed out again: re-issuing a
	// physical gantry move because a poll was retried is worse than dropping it.
	pendingCommand: {
		_id: false,
		id: String,
		verb: { type: String, enum: SERVICE_VERBS as unknown as string[] },
		args: Schema.Types.Mixed,
		issuedAt: Date,
		issuedBy: String,
		deliveredAt: Date
	},

	lastResult: {
		_id: false,
		id: String,
		verb: String,
		ok: Boolean,
		detail: String,
		completedAt: Date
	},

	// Full operator trail for this session (also mirrored into AuditLog).
	history: [{
		_id: false,
		verb: String,
		args: Schema.Types.Mixed,
		ok: Boolean,
		detail: String,
		by: String,
		at: Date
	}],

	requestedBy: String,
	closedReason: String,
	createdAt: { type: Date, default: () => new Date() },
	updatedAt: { type: Date, default: () => new Date() },
	closedAt: Date
// minimize:false so an empty `args: {}` survives the round-trip to the robot,
// same reasoning as ot2-bridge-command.ts.
}, { timestamps: false, minimize: false });

// One lookup shape: "is there a live session for this run?"
ot2ServiceSessionSchema.index({ opentronsRunId: 1, status: 1 });
ot2ServiceSessionSchema.index({ robotId: 1, createdAt: -1 });
// History self-cleans 7 days after the session closes.
ot2ServiceSessionSchema.index({ closedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export const Ot2ServiceSession = mongoose.models.Ot2ServiceSession
	|| mongoose.model('Ot2ServiceSession', ot2ServiceSessionSchema, 'ot2_service_sessions');
