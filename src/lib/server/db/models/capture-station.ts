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
		robotArm: Boolean,
		// Timed microscope grid-sequence engine (CV-MICROSCOPE-01). Gates the
		// "Microscope sequence" panel on /capture.
		sequence: Boolean
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

/**
 * Heartbeat freshness window — three missed 30 s heartbeats. A station whose
 * lastSeenAt is older than this is treated as offline regardless of the
 * stored status field.
 */
export const STALE_THRESHOLD_MS = 90_000;

type StatusInput =
	| { lastSeenAt?: Date | string | null; status?: string | null }
	| null
	| undefined;

/**
 * Pure status-from-snapshot derivation. Read-time only — does not mutate.
 *
 *   - lastSeenAt missing → 'offline' (never registered or never heartbeated)
 *   - lastSeenAt older than STALE_THRESHOLD_MS → 'offline'
 *   - otherwise the stored status, defaulting to 'online' when unset.
 *
 * Per docs/prds/PI-STATION-ADMIN-AND-LIFECYCLE.md story C4. Story C5
 * materializes the derivation back to Mongo on a schedule so admin list
 * filters can rely on the stored field.
 */
export function deriveStatus(doc: StatusInput): 'online' | 'offline' | 'degraded' {
	if (!doc?.lastSeenAt) return 'offline';
	const ageMs = Date.now() - new Date(doc.lastSeenAt).getTime();
	if (ageMs > STALE_THRESHOLD_MS) return 'offline';
	if (doc.status === 'degraded') return 'degraded';
	return 'online';
}
