import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import type { CaptureStationCamera } from '../../../types/capture-station.js';

const operatorRefSchema = new Schema(
	{ _id: String, username: String },
	{ _id: false }
);

const currentOperatorSchema = new Schema(
	{ _id: String, username: String, since: Date },
	{ _id: false }
);

/**
 * One camera attached to a station (CV-CAMERA-02).
 *
 * A station has always had exactly one camera, with "is it a microscope?"
 * expressed as station-level state (the agent's CAMERA_PROFILE env var plus
 * capabilities.sequence). A Pi can now host several — e.g. an overview camera
 * plus a Celestron microscope — with exactly one open at a time, so optics
 * become a property of the camera rather than of the station.
 *
 * Agent-declared and agent-owned: written from the register + heartbeat
 * payloads, never edited through BIMS. The Pi's CAMERAS env var is the source
 * of truth.
 */
const stationCameraSchema = new Schema(
	{
		// Stable per-station id assigned by the agent's CAMERAS config. This is
		// the selector for the select_camera WS command and for the ?camera=
		// assertion on the Pi's preview/snapshot routes.
		id: { type: String, required: true },
		// 'overview' | 'microscope'. Drives photoType on captures taken through
		// this camera — deliberately not an enum, so an agent can introduce a
		// new role without a BIMS deploy to accept it.
		role: String,
		label: String,
		// Capture preset the agent applies: 'default' or 'microscope'.
		profile: String,
		// Whether the timed grid-sequence engine applies to this camera.
		sequence: Boolean
	},
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
		// "Microscope sequence" panel on /capture. Derived from cameras[] when
		// the agent reports one, so existing readers keep working unchanged.
		sequence: Boolean
	},
	// Cameras the agent reports (CV-CAMERA-02). Absent for agents predating it —
	// readers must treat that as "one unnamed camera" and fall back to
	// capabilities.camera rather than concluding the station has none.
	// default: undefined so existing documents aren't rewritten with an empty
	// array on the next heartbeat.
	cameras: { type: [stationCameraSchema], default: undefined },
	// Which of cameras[] is currently open. Agent-owned: the Pi keeps this in
	// memory (a restart returns it to the configured default) and re-reports it
	// every heartbeat, so BIMS reflects this rather than commanding it.
	activeCameraId: String,
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
 * Coerce an agent-supplied cameras[] payload into the stored shape.
 *
 * Returns null when the payload isn't a usable array so callers can OMIT the
 * field from their $set rather than writing an empty one. That distinction is
 * the whole point: registration and heartbeat both $set unconditionally, so an
 * older agent — which sends no cameras at all — would otherwise wipe a
 * station's camera list on its next reboot.
 *
 * Entries without a usable id are dropped, and duplicate ids keep the first
 * (the id is the selector for select_camera and the ?camera= assertion, so two
 * cameras answering to one id would make the wrong-sensor guard meaningless).
 */
export function normalizeStationCameras(raw: unknown): CaptureStationCamera[] | null {
	if (!Array.isArray(raw)) return null;
	const seen = new Set<string>();
	const out: CaptureStationCamera[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const cam = item as Record<string, unknown>;
		const id = typeof cam.id === 'string' ? cam.id.trim() : '';
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push({
			id,
			role: typeof cam.role === 'string' && cam.role.trim() ? cam.role.trim() : 'overview',
			label: typeof cam.label === 'string' && cam.label.trim() ? cam.label.trim() : id,
			profile:
				typeof cam.profile === 'string' && cam.profile.trim() ? cam.profile.trim() : 'default',
			sequence: cam.sequence === true
		});
	}
	return out.length > 0 ? out : null;
}

/**
 * Back-compat view of a station's cameras for readers that predate, or don't
 * care about, the multi-camera model. An agent that reports no cameras[] is a
 * single-camera station, not a camera-less one.
 */
export function effectiveCameras(doc: {
	cameras?: CaptureStationCamera[] | null;
	capabilities?: { camera?: boolean; sequence?: boolean } | null;
}): CaptureStationCamera[] {
	if (Array.isArray(doc?.cameras) && doc.cameras.length > 0) return doc.cameras;
	if (!doc?.capabilities?.camera) return [];
	return [
		{
			id: 'default',
			role: doc.capabilities.sequence ? 'microscope' : 'overview',
			label: 'Camera',
			profile: doc.capabilities.sequence ? 'microscope' : 'default',
			sequence: doc.capabilities.sequence === true
		}
	];
}

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
