// Outbound HTTP client for the robot-arm FastAPI server (on the Pi).
//
// Set ROBOT_ARM_BASE_URL (e.g. http://arm-pi:8000) and ROBOT_ARM_API_KEY
// in BIMS .env. The Pi-side env must have ROBOT_ARM_API_KEY matching.

import { env } from '$env/dynamic/private';

interface FetchOptions {
	method?: 'GET' | 'POST';
	body?: unknown;
	timeoutMs?: number;
}

function baseUrl(): string {
	const url = env.ROBOT_ARM_BASE_URL;
	if (!url) throw new Error('ROBOT_ARM_BASE_URL not set in env');
	return url.replace(/\/$/, '');
}

export async function robotArmFetch<T>(path: string, opts: FetchOptions = {}): Promise<T> {
	const apiKey = env.ROBOT_ARM_API_KEY;
	if (!apiKey) throw new Error('ROBOT_ARM_API_KEY not set in env');

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
	try {
		const res = await fetch(`${baseUrl()}${path}`, {
			method: opts.method ?? 'GET',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey
			},
			body: opts.body ? JSON.stringify(opts.body) : undefined,
			signal: controller.signal
		});
		const text = await res.text();
		const data = text ? JSON.parse(text) : null;
		if (!res.ok) {
			const detail =
				typeof data === 'object' && data && 'detail' in data
					? (data as { detail: unknown }).detail
					: text;
			throw new Error(
				`robot-arm ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
			);
		}
		return data as T;
	} finally {
		clearTimeout(timeout);
	}
}

// Typed convenience wrappers for the Pi endpoints we use.
//
// Match shapes in robot-arm/src/server/app.py:
//   POST /teleop/start  body: TeleopRequest
//   POST /record/start  body: RecordRequest
//   POST /replay/start  body: ReplayRequest
//   POST /sessions/stop
//   GET  /sessions/active
//   GET  /recordings

export interface TriggeredBy {
	_id: string;
	username: string;
}

export interface ActiveSession {
	active: { run_id: string; kind: string } | null;
}

export interface SessionStarted {
	run_id: string;
	kind: 'teleop' | 'record' | 'replay';
}

export interface RecordingSidecar {
	schema_version: number;
	frame_count: number;
	lot_id?: string;
	manufacturing_step?: string;
	recorded_during_run_id?: string;
	operator?: string;
	started_at_iso?: string;
	rate_hz?: number;
	run_id?: string;
}

export interface RecordingMeta {
	name: string;
	path: string;
	size_bytes: number;
	modified: string;
	// Provenance sidecar; null for legacy recordings without one.
	meta?: RecordingSidecar | null;
}

interface ProvenanceFields {
	lot_id?: string;
	manufacturing_step?: string;
	recorded_during_run_id?: string;
}

export interface PreflightResult {
	ready: boolean;
	leader_alive: boolean;
	follower_alive: boolean;
	expected: Record<string, number>;
	actual: Record<string, number>;
	deltas: Record<string, number>;
	tolerance_steps: number;
	issues: string[];
}

export interface JogCalibration {
	joints: Record<string, { zero_step: number; sign: number }>;
	axes_map: { x: string; y: string; z: string };
	axes_sign: { x: number; y: number; z: number };
}

export interface ArmPose {
	x_mm: number;
	y_mm: number;
	z_mm: number;
	joint_angles_deg: Record<string, number>;
	joint_steps: Record<string, number>;
	calibration_source: string;
	calibration: JogCalibration;
}

export interface JogCartesianResult {
	requested: { dx_mm: number; dy_mm: number; dz_mm: number };
	before: ArmPose;
	after_target: ArmPose;
	goal_steps: Record<string, number>;
	clamped: Record<string, number>;
}

export interface PortInfo {
	port: string;
	present: boolean;
	in_use: boolean;
}

export interface PortStatus {
	leader: PortInfo;
	follower: PortInfo;
	active: { run_id: string; kind: string } | null;
}

export const robotArm = {
	getActive: () => robotArmFetch<ActiveSession>('/sessions/active'),
	getPortStatus: () => robotArmFetch<PortStatus>('/ports/status'),
	stop: () => robotArmFetch<{ stopped_run_id: string | null }>('/sessions/stop', { method: 'POST' }),
	startTeleop: (
		body: { rate_hz?: number; duration_s?: number; triggered_by?: TriggeredBy } & ProvenanceFields
	) => robotArmFetch<SessionStarted>('/teleop/start', { method: 'POST', body }),
	startRecord: (
		body: {
			name: string;
			rate_hz?: number;
			duration_s?: number;
			triggered_by?: TriggeredBy;
		} & ProvenanceFields
	) => robotArmFetch<SessionStarted>('/record/start', { method: 'POST', body }),
	startReplay: (
		body: {
			source: string;
			loops?: number;
			triggered_by?: TriggeredBy;
			enforce_preflight?: boolean;
			preflight_tolerance_steps?: number;
		} & ProvenanceFields
	) => robotArmFetch<SessionStarted>('/replay/start', { method: 'POST', body }),
	preflightReplay: (body: { source: string; tolerance_steps?: number }) =>
		robotArmFetch<PreflightResult>('/replay/preflight', { method: 'POST', body }),
	getPose: () => robotArmFetch<ArmPose>('/pose'),
	jogCartesian: (body: { dx_mm: number; dy_mm: number; dz_mm: number; max_step_delta?: number }) =>
		robotArmFetch<JogCartesianResult>('/jog/cartesian', { method: 'POST', body }),
	reloadJogCalibration: () =>
		robotArmFetch<{ calibration_source: string; calibration: JogCalibration }>(
			'/jog/reload-calibration',
			{ method: 'POST' }
		),
	setTorque: (enable: boolean) =>
		robotArmFetch<{ enabled: boolean }>('/torque', { method: 'POST', body: { enable } }),
	listRecordings: () => robotArmFetch<{ recordings: RecordingMeta[] }>('/recordings'),
	health: () => robotArmFetch<{ status: string; service: string; version: string }>('/health')
};
