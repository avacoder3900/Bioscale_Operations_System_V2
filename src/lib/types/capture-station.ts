/**
 * Shared types for the Pi-hosted capture station registry.
 * Imported by both server endpoints and browser code, so no Mongoose
 * imports allowed here.
 */

export type CaptureStationStatus = 'online' | 'offline' | 'degraded';

export type CaptureStationMode = 'free' | 'assigned';

export interface CaptureStationCapabilities {
	camera: boolean;
	scanner: boolean;
	led: boolean;
	robotArm: boolean;
	/** Timed microscope grid-sequence engine (CV-MICROSCOPE-01). */
	sequence?: boolean;
}

export interface CaptureStationOperator {
	_id: string;
	username: string;
	since: string | Date;
}

/**
 * One camera attached to a station (CV-CAMERA-02).
 *
 * A Pi may host several — typically an overview camera plus a Celestron
 * microscope — but exactly one is open at a time: the device can't be shared,
 * and two simultaneous JPEG encoders is the load that browned out a station
 * PSU. Declared by the agent's CAMERAS env var; BIMS reflects it, never sets it.
 */
export interface CaptureStationCamera {
	/** Stable per-station id from the agent's CAMERAS config. */
	id: string;
	/**
	 * Typically 'overview' or 'microscope'. Widened to string on purpose so an
	 * agent can introduce a role without a BIMS deploy to accept it; treat
	 * anything unrecognized as an overview camera.
	 */
	role?: string;
	label?: string;
	/** Capture preset the agent applies: 'default' or 'microscope'. */
	profile?: string;
	/** Whether the timed grid-sequence engine applies to this camera. */
	sequence?: boolean;
}

export interface CaptureStation {
	_id: string;
	name: string;
	hostname: string;
	ipAddress?: string;
	location?: string;
	agentVersion?: string;
	lastSeenAt?: string | Date;
	status?: CaptureStationStatus;
	capabilities?: CaptureStationCapabilities;
	/**
	 * Absent for agents predating CV-CAMERA-02 — treat that as "one unnamed
	 * camera" and fall back to capabilities.camera, not as "no cameras".
	 */
	cameras?: CaptureStationCamera[];
	/** Which of cameras[] is currently open, as last reported by the agent. */
	activeCameraId?: string;
	mode: CaptureStationMode;
	assignedPhase?: string;
	currentOperator?: CaptureStationOperator;
	createdBy?: { _id: string; username: string };
	createdAt?: string | Date;
}

export interface RegisterStationRequest {
	name: string;
	hostname: string;
	ipAddress?: string;
	capabilities: CaptureStationCapabilities;
	agentVersion?: string;
}

export interface RegisterStationResponse {
	_id: string;
	/**
	 * HS256 signing secret used by the Pi to verify short-lived browser→Pi
	 * auth JWTs. Returned ONCE on initial registration; rotated only by
	 * re-registering the station.
	 */
	jwtSecret: string;
}

/**
 * Pi-side self-registration payload. Sent by setup-station.sh and (on
 * subsequent boots) the agent itself. Distinct from RegisterStationRequest
 * because (a) it's authenticated by STATION_AGENT_KEY rather than a BIMS
 * user session, (b) it carries an optional stationId hint so the Pi's
 * locally-generated UUID can be used as the BIMS-side _id, and (c) it
 * supports an explicit secret-rotation flag.
 */
export interface RegisterAgentRequest {
	stationId?: string;
	name: string;
	hostname: string;
	ipAddress?: string;
	capabilities: CaptureStationCapabilities;
	/**
	 * Cameras attached to this station (CV-CAMERA-02). Optional: agents
	 * predating it omit it, and the endpoint must then leave any stored list
	 * alone rather than clearing it.
	 */
	cameras?: CaptureStationCamera[];
	activeCameraId?: string;
	agentVersion?: string;
	/**
	 * When true on a re-registration call, mints a fresh jwtSecret and
	 * returns it. Default false — re-registrations preserve the existing
	 * secret so the Pi's local copy in /etc/bims/station.env stays valid.
	 */
	regenerateSecret?: boolean;
}

export interface RegisterAgentResponse {
	_id: string;
	/**
	 * Present on first-time registration, or on re-registration with
	 * regenerateSecret: true. Absent on re-registration without rotation —
	 * the Pi already has the secret on disk.
	 */
	jwtSecret?: string;
}

/**
 * Per-Pi liveness + capability snapshot. Mirrors the body of /health on
 * the Pi agent. Sent every HEARTBEAT_INTERVAL_S (default 30s) to
 * POST /api/cv/stations/[id]/heartbeat.
 */
export interface HeartbeatRequest {
	/**
	 * Health of the camera that is currently OPEN, not of every attached
	 * camera. An idle second camera must never drag a station to 'degraded'.
	 */
	cameraOk: boolean;
	scannerOk: boolean;
	ledOk: boolean;
	uptimeS: number;
	agentVersion?: string;
	/**
	 * Camera list + active selection ride the heartbeat as well as
	 * registration, so BIMS converges within one interval when a station's
	 * CAMERAS config changes and it restarts without re-registering.
	 * Optional — omitted by agents predating CV-CAMERA-02.
	 */
	cameras?: CaptureStationCamera[];
	activeCameraId?: string;
}

export type LockStationResponse =
	| { ok: true }
	| { ok: false; heldBy: { username: string; since: string | Date } };
