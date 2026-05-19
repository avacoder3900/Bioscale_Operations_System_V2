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
	/** Plaintext station token — returned ONCE on initial registration only. */
	token: string;
}

export type LockStationResponse =
	| { ok: true }
	| { ok: false; heldBy: { username: string; since: string | Date } };
