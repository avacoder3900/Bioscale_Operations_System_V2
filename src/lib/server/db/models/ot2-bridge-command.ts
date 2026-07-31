import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * OT-2 command bridge queue (OT2-BRIDGE-1).
 *
 * BIMS (which cannot reach the lab LAN from Vercel) enqueues commands here;
 * the ot2-bridge daemon on each robot long-polls /api/agent/ot2/poll, claims
 * the oldest pending command for its deviceId, executes it against the
 * robot's local HTTP API (kind 'http') or runs an on-robot routine (kind
 * 'sweep' / 'deck_scan'), and posts the outcome back.
 */
const ot2BridgeCommandSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	robotId: String,             // OpentronsRobot._id
	deviceId: String,            // ot2-<slot>-bridge
	kind: { type: String, enum: ['http', 'sweep', 'deck_scan', 'upload_protocol', 'restart_robot_server', 'auto_resume_run', 'calibrate_tip'], required: true },
	// kind 'http': relay this request to http://localhost:31950 on the robot
	request: {
		method: String,
		path: String,
		body: Schema.Types.Mixed
	},
	// kind 'sweep' / 'deck_scan': routine parameters (see OT2-BRIDGE-2)
	// kind 'upload_protocol': { fileName, fileB64 } — base64 .py uploaded to the
	// robot's /protocols then analyzed on-robot (see OT2-BRIDGE-3)
	payload: Schema.Types.Mixed,
	status: {
		type: String,
		enum: ['pending', 'claimed', 'completed', 'failed', 'expired'],
		default: 'pending'
	},
	// kind 'http': the robot's HTTP response, relayed verbatim
	result: {
		status: Number,
		body: Schema.Types.Mixed
	},
	error: String,
	ttlMs: { type: Number, default: 45_000 }, // pending → expired if unclaimed
	requestedBy: String,
	createdAt: { type: Date, default: () => new Date() },
	claimedAt: Date,
	completedAt: Date
// minimize:false is REQUIRED — this queue relays request bodies + command
// payloads VERBATIM to the robot. Mongoose's default minimize:true deletes empty
// objects on save, which silently strips Opentrons labware-def fields like
// `groups[].metadata: {}` → the robot rejects the def with "Field required".
}, { timestamps: false, minimize: false });

ot2BridgeCommandSchema.index({ deviceId: 1, status: 1, createdAt: 1 });
ot2BridgeCommandSchema.index({ robotId: 1, createdAt: -1 });
// Sweep-status endpoint (polled in a loop by the deck-loading UI during every
// scan) looks up by kind + payload.sweepRunId — was the #1 offender in Atlas
// Query Insights 2026-07-31: 14.5K executions/day, ~36,000 docs examined per
// doc returned (full 50K-doc scan per poll tick).
ot2BridgeCommandSchema.index({ kind: 1, 'payload.sweepRunId': 1 });
// History self-cleans 7 days after completion (completedAt is also set when
// a command is failed/expired, so every terminal doc ages out).
// Commands are queue messages, not records — their useful life is minutes,
// and the robots generate ~3,600/day with fat payloads (~460MB by 2026-07-31).
// Completed commands keep 3 days for debugging; 7-day createdAt TTL is the
// backstop for failed/expired/stuck states that previously lived forever.
ot2BridgeCommandSchema.index({ completedAt: 1 }, { expireAfterSeconds: 3 * 24 * 3600 });
ot2BridgeCommandSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export const Ot2BridgeCommand = mongoose.models.Ot2BridgeCommand
	|| mongoose.model('Ot2BridgeCommand', ot2BridgeCommandSchema, 'ot2_bridge_commands');
