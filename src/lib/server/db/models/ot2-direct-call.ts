import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * One robot call the operator's browser made DIRECTLY to an OT-2 over the
 * tailnet (OT2-TAILNET-4). Calls on the queue line are already traced by
 * Ot2BridgeCommand; this is the equivalent trace for the tailnet line, so
 * moving a robot to Tailscale does not lose "what did BIMS tell the robot, when".
 *
 * Written by POST /api/opentrons-lab/robots/[id]/direct-calls (the browser
 * batches its call log there). Same 3-day retention as Ot2BridgeCommand.
 */
const ot2DirectCallSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	robotId: String,          // OpentronsRobot._id
	sessionId: String,        // one per page session (see $lib/opentrons/direct-client)
	verb: String,             // ot2-protocol verb, e.g. 'run.action', 'mx.jog'
	method: String,           // robot HTTP method
	path: String,             // robot path, e.g. /runs/<rid>/actions
	status: Number,           // robot HTTP status (0 = no response / network error)
	ok: Boolean,
	latencyMs: Number,
	error: String,
	username: String,         // stamped server-side from the session, never trusted from the body
	userId: String,
	at: Date                  // when the browser made the call
}, { timestamps: { createdAt: true, updatedAt: false } });

ot2DirectCallSchema.index({ robotId: 1, at: -1 });
ot2DirectCallSchema.index({ at: 1 }, { expireAfterSeconds: 3 * 24 * 3600 });

export const Ot2DirectCall = mongoose.models.Ot2DirectCall
	|| mongoose.model('Ot2DirectCall', ot2DirectCallSchema, 'ot2_direct_calls');
