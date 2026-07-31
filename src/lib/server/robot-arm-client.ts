// Outbound HTTP client for the robot-arm FastAPI server (on the Pi).
//
// Set ROBOT_ARM_BASE_URL (e.g. http://arm-pi:8000) and ROBOT_ARM_API_KEY
// in BIMS .env. The Pi-side env must have ROBOT_ARM_API_KEY matching.

import { env } from '$env/dynamic/private';

interface FetchOptions {
	method?: 'GET' | 'POST' | 'DELETE';
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
	backlash_applied: Record<string, number>;
}

export interface PortInfo {
	port: string;
	present: boolean;
	in_use: boolean;
}

export interface PortCandidate {
	port: string;
	serial_number: string;
	vid_pid: string;
	description: string;
	expected_role: 'leader' | 'follower' | null;
}

export interface PortStatus {
	leader: PortInfo;
	follower: PortInfo;
	active: { run_id: string; kind: string } | null;
	candidates?: PortCandidate[];
	diagnosis?: string;
}

// GET /health/preflight — the Pi's own readiness assessment. Every check
// carries a human-readable `detail`; `diagnosis` names the concrete fix when
// a port is misconfigured. We render both verbatim rather than re-deriving
// them in TypeScript, so the two can't drift.
export interface PreflightCheck {
	ok: boolean;
	detail: string;
	configured?: string;
	value?: boolean;
}

export interface ArmPreflight {
	ok: boolean;
	service: string;
	version: string;
	checks: {
		fastapi?: PreflightCheck;
		api_key_configured?: PreflightCheck;
		leader_port?: PreflightCheck;
		follower_port?: PreflightCheck;
		// dry_run.ok is always true — dry-run vs live is a config choice, not a
		// fault. The state we care about is `value`.
		dry_run?: PreflightCheck;
	};
	candidates?: PortCandidate[];
	diagnosis?: string;
	active: { run_id: string; kind: string } | null;
}

// GET /tasks — the registry parsed from the Pi's src/config/tasks.yaml.
export interface ArmTask {
	name: string;
	version?: string;
	module?: string;
	class?: string;
	description?: string;
}

// POST /tasks/{name}/run
export interface ArmTaskStarted {
	run_id: string;
	status: string;
	task_name: string;
	lot_id: string | null;
}

export interface SyncZeroRecord {
	version: string;
	captured_at: string;
	captured_by: TriggeredBy | null;
	joint_names: string[];
	leader_positions: number[];
	follower_positions: number[];
	follower_min: number[];
	follower_max: number[];
}

export interface CalibrationStatus {
	saved: SyncZeroRecord | null;
	live: {
		leader_positions: (number | null)[];
		follower_positions: (number | null)[];
		joint_names: string[];
	} | null;
	deltas: {
		leader: (number | null)[];
		follower: (number | null)[];
	} | null;
	live_error?: string;
}

// ---------------------------------------------------------------------------
// Multi-pose joint map (v2 calibration)
//
// Sync-zero above captures ONE matched pose and can only ever produce an
// offset. The joint map captures several poses across each joint's travel and
// least-squares fits a per-joint scale + offset, which is what actually
// corrects the leader/follower gearing mismatch (1/345 vs 1/191 vs 1/147).
// ---------------------------------------------------------------------------

/**
 * Per-joint trustworthiness of the fitted slope. Mirrors `_fit_one` in
 * src/utils/joint_map.py on the Pi. Anything other than `ok` means that
 * joint fell back to scale=1.0 (mirror) with an averaged offset — safe, but
 * not calibrated. The UI must say which, and why.
 */
export type JointFitStatus =
	| 'ok'
	| 'no_fit'
	| 'single_pose'
	| 'insufficient_range'
	| 'implausible_scale';

export interface CapturedPose {
	index: number;
	captured_at: string;
	captured_by: TriggeredBy | null;
	leader: number[];
	follower: number[];
}

export interface JointMapFit {
	scale: number[];
	offset: number[];
	residual_max: number[];
	status: JointFitStatus[];
	joint_names: string[];
	n_poses: number;
	fitted_at: string;
}

export interface JointMapRecord {
	version: string;
	joint_names: string[];
	poses: CapturedPose[];
	fit: JointMapFit;
}

export interface JointMapStatus {
	map: JointMapRecord | null;
	live: {
		joint_names: string[];
		leader: (number | null)[];
		follower: (number | null)[];
		predicted_follower: (number | null)[];
		/** follower − predicted. Growing with travel ⇒ scale still wrong. */
		tracking_error: (number | null)[];
	} | null;
	live_error: string | null;
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
	jogCartesian: (body: {
		dx_mm: number;
		dy_mm: number;
		dz_mm: number;
		max_step_delta?: number;
		backlash_comp?: boolean;
	}) => robotArmFetch<JogCartesianResult>('/jog/cartesian', { method: 'POST', body }),
	resetBacklash: () =>
		robotArmFetch<{ reset: boolean }>('/jog/reset-backlash', { method: 'POST' }),
	reloadJogCalibration: () =>
		robotArmFetch<{ calibration_source: string; calibration: JogCalibration }>(
			'/jog/reload-calibration',
			{ method: 'POST' }
		),
	setTorque: (enable: boolean) =>
		robotArmFetch<{ enabled: boolean }>('/torque', { method: 'POST', body: { enable } }),
	jogJoint: (sid: number, delta_steps: number, speed?: number) =>
		robotArmFetch<{ id: number; goal: number }>(`/servos/${sid}/jog`, {
			method: 'POST',
			body: { delta_steps, ...(speed !== undefined ? { speed } : {}) }
		}),
	listRecordings: () => robotArmFetch<{ recordings: RecordingMeta[] }>('/recordings'),
	health: () => robotArmFetch<{ status: string; service: string; version: string }>('/health'),

	// Connection health for the ARM-01 panel. Enumerating serial ports is
	// slower than a bare /health, so give it more room than the 5s default
	// without going all the way to the 15s used for calibration.
	preflight: () => robotArmFetch<ArmPreflight>('/health/preflight', { timeoutMs: 8000 }),

	listTasks: () => robotArmFetch<{ tasks: ArmTask[] }>('/tasks'),

	// Task startup does hardware preflight on the Pi before returning, so it
	// gets the same 15s allowance as the calibration calls above.
	startTask: (
		name: string,
		body: { lot_id?: string | null; triggered_by?: TriggeredBy; auto_confirm?: boolean } = {}
	) =>
		robotArmFetch<ArmTaskStarted>(`/tasks/${encodeURIComponent(name)}/run`, {
			method: 'POST',
			body,
			timeoutMs: 15000
		}),

	// Live budget is 10s, not 15s: the calibrate load awaits getActive (5s),
	// then this, then getJointMap sequentially — the serial bus is
	// single-owner so they cannot be parallelised. 5+10+10=25s has to stay
	// under the adapter's maxDuration of 30 in svelte.config.js, or Vercel
	// kills the invocation with a bare 504 and the live_error banner these
	// wrappers exist to render never gets a chance to.
	getCalibration: (opts: { live?: boolean } = {}) =>
		robotArmFetch<CalibrationStatus>(
			`/calibrate/sync${opts.live ? '?live=true' : ''}`,
			{ timeoutMs: opts.live ? 10000 : 5000 }
		),
	captureCalibration: (body: { triggered_by?: TriggeredBy } = {}) =>
		robotArmFetch<SyncZeroRecord>('/calibrate/sync', {
			method: 'POST',
			body,
			timeoutMs: 15000
		}),
	clearCalibration: () =>
		robotArmFetch<{ removed: boolean }>('/calibrate/sync', {
			method: 'DELETE',
			timeoutMs: 5000
		}),

	// --- multi-pose joint map ---

	// 10s live, for the shared-deadline reason documented on getCalibration.
	getJointMap: (opts: { live?: boolean } = {}) =>
		robotArmFetch<JointMapStatus>(`/calibrate/map${opts.live ? '?live=true' : ''}`, {
			timeoutMs: opts.live ? 10000 : 5000
		}),

	// Capture opens both buses and briefly holds follower torque before
	// reading, so it needs the same 15s allowance as a sync-zero capture.
	capturePose: (body: { triggered_by?: TriggeredBy } = {}) =>
		robotArmFetch<JointMapRecord>('/calibrate/map/poses', {
			method: 'POST',
			body,
			timeoutMs: 15000
		}),

	// Delete and clear only touch disk (they refit from saved poses), so the
	// default timeout is plenty.
	deletePose: (index: number) =>
		robotArmFetch<JointMapRecord>(`/calibrate/map/poses/${index}`, {
			method: 'DELETE',
			timeoutMs: 5000
		}),
	clearJointMap: () =>
		robotArmFetch<{ removed: boolean }>('/calibrate/map', {
			method: 'DELETE',
			timeoutMs: 5000
		})
};
