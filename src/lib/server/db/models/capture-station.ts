import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRefSchema = new Schema(
	{ _id: String, username: String },
	{ _id: false }
);

const currentOperatorSchema = new Schema(
	{ _id: String, username: String, since: Date },
	{ _id: false }
);

const captureStationSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: { type: String, required: true },
	hostname: { type: String, required: true },
	ipAddress: String,
	location: String,
	agentVersion: String,
	// Operator-driven liveness — bumped on /api/cv/stations registration and
	// re-registration. agentReportedAt is the heartbeat-driven counterpart;
	// keeping them separate lets a future audit distinguish "operator selected
	// this station" from "agent phoned home."
	lastSeenAt: Date,
	agentReportedAt: Date,
	// status reflects the last heartbeat OR a derived-stale state. The
	// deriveStatus helper in story C4 returns 'offline' for stations whose
	// lastSeenAt is older than 90 s regardless of stored value.
	status: { type: String, enum: ['online', 'offline', 'degraded'] },
	// Snapshot of the Pi's most recent /health response. Populated by the
	// heartbeat endpoint (C2); shape mirrors agent.py's health() handler.
	health: {
		_id: false,
		cameraOk: Boolean,
		scannerOk: Boolean,
		ledOk: Boolean,
		uptimeS: Number,
		agentVersion: String
	},
	capabilities: {
		_id: false,
		camera: Boolean,
		scanner: Boolean,
		led: Boolean,
		robotArm: Boolean
	},
	mode: { type: String, enum: ['free', 'assigned'], default: 'free' },
	assignedPhase: String,
	currentOperator: currentOperatorSchema,
	// HS256 signing secret for short-lived browser→Pi auth JWTs.
	// Plaintext at rest; rotated by re-registering the station.
	jwtSecret: String,
	createdBy: operatorRefSchema
}, { timestamps: true });

captureStationSchema.index({ hostname: 1 }, { unique: true });

export const CaptureStation = mongoose.models.CaptureStation || mongoose.model('CaptureStation', captureStationSchema, 'capture_stations');
