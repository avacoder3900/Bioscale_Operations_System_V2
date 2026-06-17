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
}

export interface CaptureStationOperator {
	_id: string;
	username: string;
	since: string | Date;
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
	cameraOk: boolean;
	scannerOk: boolean;
	ledOk: boolean;
	uptimeS: number;
	agentVersion?: string;
}

export type LockStationResponse =
	| { ok: true }
	| { ok: false; heldBy: { username: string; since: string | Date } };
