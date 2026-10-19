// Outbound HTTP client for the robot-arm FastAPI server (on the Pi).
//
// Set ROBOT_ARM_BASE_URL (e.g. http://arm-pi:8000) and ROBOT_ARM_API_KEY
// in BIMS .env. The Pi-side env must have ROBOT_ARM_API_KEY matching.
//
// Two routes to the Pi (2026-10-19). The office uplink is Starlink and the
// Pi's Tailscale relay connection is reset every ~30 s, so the Funnel at
// ROBOT_ARM_BASE_URL fails for minutes-to-hours at a time. The Pi also runs a
// Cloudflare quick tunnel and registers its (changing) URL in
// robot_arm_endpoints via POST /api/robot-arm/tunnel. Requests go to whichever
// route last worked, tunnel first by default, and fall over to the other.

import { env } from '$env/dynamic/private';
import { connectDB } from './db/connection';
import { RobotArmEndpoint } from './db/models';

interface FetchOptions {
	method?: 'GET' | 'POST' | 'DELETE';
	body?: unknown;
	timeoutMs?: number;
}

// The Pi heartbeats its tunnel URL every 5 min; a row older than this means the
// tunnel (or the Pi) is gone, so don't waste the request budget on it.
const TUNNEL_MAX_AGE_MS = 15 * 60 * 1000;
const TUNNEL_CACHE_MS = 30_000;

// Retry limit (option D). Attempts alternate between routes and all share the
// caller's single timeoutMs budget, so a retry can never push a page past the
// adapter's 30 s maxDuration.
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 300;

let tunnelCache: { url: string | null; at: number } | null = null;
let lastGoodRoute: string | null = null;

export function invalidateTunnelCache(): void {
	tunnelCache = null;
}

async function tunnelUrl(): Promise<string | null> {
	if (tunnelCache && Date.now() - tunnelCache.at < TUNNEL_CACHE_MS) return tunnelCache.url;
	let url: string | null = null;
	try {
		await connectDB();
		const row = (await RobotArmEndpoint.findById('tunnel').lean()) as {
			url?: string;
			registeredAt?: Date;
		} | null;
		if (row?.url && row.registeredAt && Date.now() - new Date(row.registeredAt).getTime() < TUNNEL_MAX_AGE_MS) {
			url = row.url;
		}
	} catch {
		// A DB hiccup must not take the arm down with it; use the Funnel alone.
		url = null;
	}
	tunnelCache = { url, at: Date.now() };
	return url;
}

async function armRoutes(): Promise<string[]> {
	const routes: string[] = [];
	const tunnel = await tunnelUrl();
	if (tunnel) routes.push(tunnel);
	const funnel = env.ROBOT_ARM_BASE_URL?.replace(/\/$/, '');
	if (funnel) routes.push(funnel);
	if (!routes.length) throw new Error('ROBOT_ARM_BASE_URL not set in env');
	if (lastGoodRoute && routes.includes(lastGoodRoute)) {
		routes.sort((a, b) => (a === lastGoodRoute ? -1 : b === lastGoodRoute ? 1 : 0));
	}
	return routes;
}

/** The route the last successful request in this instance used, for display/logs. */
export function currentArmRoute(): string | null {
	return lastGoodRoute ?? env.ROBOT_ARM_BASE_URL ?? null;
}

// Failed before the request could have reached the Pi, so even a motion or
// GPIO command is safe to send again on another route. The Funnel's failure
// mode (ingress drops the TLS handshake) lands here as ECONNRESET with this
// message.
function failedBeforeSend(err: unknown): boolean {
	const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
	const code = cause?.code ?? '';
	const msg = `${(err as Error)?.message ?? ''} ${cause?.message ?? ''}`;
	return (
		['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) ||
		/before secure TLS connection was established/i.test(msg)
	);
}

function isAbort(err: unknown): boolean {
	return (err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError';
}

// Cloudflare's own error pages, not the Pi's answer. 530 means the tunnel had
// no connection to the Pi at all, so the request never arrived and any method
// may retry. 502-504 may have reached the Pi, so only reads retry on those.
function routeFailed(res: Response, idempotent: boolean): boolean {
	if (!res.headers.get('cf-ray')) return false;
	if (res.status === 530) return true;
	return idempotent && [502, 503, 504].includes(res.status);
}

async function armRequest(
	path: string,
	init: { method: string; headers: Record<string, string>; body?: string },
	timeoutMs: number
): Promise<Response> {
	const idempotent = init.method === 'GET';
	const routes = await armRoutes();
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown = new Error('fetch failed');

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		const base = routes[attempt % routes.length];
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), remaining);
		try {
			const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
			if (routeFailed(res, idempotent)) {
				lastErr = new Error(`fetch failed (route ${new URL(base).host} returned ${res.status})`);
				await res.body?.cancel().catch(() => {});
				continue;
			}
			lastGoodRoute = base;
			return res;
		} catch (err) {
			lastErr = err;
			// A timeout spent the whole budget; a mid-request failure on a
			// mutation may already have reached the Pi. Neither retries.
			if (isAbort(err) || (!idempotent && !failedBeforeSend(err))) break;
			if (lastGoodRoute === base) lastGoodRoute = null;
			await new Promise((r) => setTimeout(r, Math.min(RETRY_BACKOFF_MS, Math.max(0, deadline - Date.now()))));
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastErr;
}

export async function robotArmFetch<T>(path: string, opts: FetchOptions = {}): Promise<T> {
	const apiKey = env.ROBOT_ARM_API_KEY;
	if (!apiKey) throw new Error('ROBOT_ARM_API_KEY not set in env');

	const res = await armRequest(
		path,
		{
			method: opts.method ?? 'GET',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey
			},
			body: opts.body ? JSON.stringify(opts.body) : undefined
		},
		opts.timeoutMs ?? 5000
	);
	const text = await res.text();
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		// Proxy error pages (Cloudflare, Tailscale) are HTML; report the status, not a parse error.
		if (res.ok) throw new Error(`robot-arm ${res.status}: response was not JSON`);
	}
	if (!res.ok) {
		const detail =
			typeof data === 'object' && data && 'detail' in data
				? (data as { detail: unknown }).detail
				: text.slice(0, 200);
		throw new Error(
			`robot-arm ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
		);
	}
	return data as T;
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

export function recordingStem(name: string): string {
	return name.replace(/\.jsonl$/i, '');
}

export interface RecordingExport {
	name: string;
	jsonl: string;
	meta: RecordingSidecar | null;
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
export interface GpioPulseResult {
	pins: number[];
	ms: number;
	gap_ms?: number;
	simulated: boolean;
	elapsed_ms: number;
}

export interface GpioStatus {
	pins: Record<string, { state: number }>;
	simulated: boolean;
	busy: boolean;
}

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

// Camera status, mirroring robot-arm/src/server/cameras.py CameraWorker.status().
// Every field here is reported by the Pi; none of it is inferred or persisted.
export interface CameraStatus {
	name: string;
	device: string | null;
	running: boolean;
	requested: { width: number; height: number; fps: number; quality: number };
	/** [h, w, channels] of the last decoded frame; null before the first frame. */
	actual_size: number[] | null;
	frames: number;
	last_frame_age_s: number | null;
	stale: boolean;
	error: string | null;
}

// Depth at points, mirroring robot-arm/src/server/depth.py sample().
export interface DepthSample {
	available: boolean;
	units: 'mm';
	/** One entry per requested point; null = no valid depth there. */
	depth_mm: (number | null)[];
	/** e.g. "realsense:Intel RealSense L515 f1234567" */
	source?: string | null;
	reason?: string | null;
}

/**
 * Fetch raw (non-JSON) bytes from the Pi — currently only camera JPEGs.
 *
 * Deliberately separate from robotArmFetch, which JSON.parses every body and
 * would corrupt a JPEG. Returns the bytes plus the upstream content type so
 * the proxy route can pass both through unchanged; nothing here re-encodes.
 */
export async function robotArmFetchBytes(
	path: string,
	opts: { timeoutMs?: number } = {}
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
	const apiKey = env.ROBOT_ARM_API_KEY;
	if (!apiKey) throw new Error('ROBOT_ARM_API_KEY not set in env');

	const res = await armRequest(
		path,
		{ method: 'GET', headers: { 'x-api-key': apiKey } },
		opts.timeoutMs ?? 5000
	);
	if (!res.ok) {
		// Error bodies from FastAPI are small JSON/text, safe to read as text.
		const text = await res.text().catch(() => '');
		throw new Error(`robot-arm ${res.status}: ${text.slice(0, 200)}`);
	}
	return {
		bytes: await res.arrayBuffer(),
		contentType: res.headers.get('content-type') ?? 'image/jpeg'
	};
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
	// Recording trash (recordings_admin.py on the Pi). BIMS exports a recording
	// to R2 before deleting it, and restores from R2 on recover. Bodies carry the
	// whole JSONL, so these get more room than the 5s default.
	// The live Pi lists recordings by file name ("x.jsonl"); its trash router
	// wants the bare stem, so every wrapper strips the extension.
	exportRecording: (name: string) =>
		robotArmFetch<RecordingExport>(`/recordings/${encodeURIComponent(recordingStem(name))}/export`, {
			timeoutMs: 20000
		}),
	deleteRecording: (name: string) =>
		robotArmFetch<{ deleted: string }>(`/recordings/${encodeURIComponent(recordingStem(name))}`, {
			method: 'DELETE',
			timeoutMs: 10000
		}),
	restoreRecording: (body: RecordingExport) =>
		robotArmFetch<{ restored: string }>('/recordings/restore', {
			method: 'POST',
			body: { ...body, name: recordingStem(body.name) },
			timeoutMs: 20000
		}),
	health: () => robotArmFetch<{ status: string; service: string; version: string }>('/health'),

	// Connection health for the ARM-01 panel. Enumerating serial ports is
	// slower than a bare /health, so give it more room than the 5s default
	// without going all the way to the 15s used for calibration.
	// Default 8s suits a page load that exists to diagnose the arm. The ARM-02
	// layout load overrides it to 3s: it renders on all four tabs, so it must
	// never be the thing that stalls a page. Safe to call often — the Pi only
	// checks port *presence* against comports(), it never opens the bus, so
	// this cannot contend with the calibrate load's servo traffic.
	preflight: (opts: { timeoutMs?: number } = {}) =>
		robotArmFetch<ArmPreflight>('/health/preflight', { timeoutMs: opts.timeoutMs ?? 8000 }),

	listTasks: () => robotArmFetch<{ tasks: ArmTask[] }>('/tasks'),

	// Solenoid GPIO on the arm Pi (cartridge chute). The Pi owns the pins and
	// serializes pulses; a 409 means a pulse is already in progress. Budgets
	// cover the longest allowed pulse (2 s) and the longest sequence
	// (2 pins x 2 s + 5 s gap) with headroom, under the 30 s adapter limit.
	pulseGpio: (body: { pin: number; ms: number }) =>
		robotArmFetch<GpioPulseResult>('/gpio/pulse', { method: 'POST', body, timeoutMs: 6000 }),
	sequenceGpio: (body: { pins: number[]; ms: number; gap_ms: number }) =>
		robotArmFetch<GpioPulseResult>('/gpio/sequence', { method: 'POST', body, timeoutMs: 14000 }),
	gpioStatus: () => robotArmFetch<GpioStatus>('/gpio/status'),

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
		}),

	// --- Cameras (ARM-02) -------------------------------------------------
	//
	// listCameras is safe to call from a layout load on every arm page view:
	// cameras.py:408-411 documents that status "deliberately does *not* start
	// workers — polling status should never power on a camera as a side
	// effect". It also touches no serial bus, so it cannot contend with the
	// calibrate load's 25s of servo traffic (see the getCalibration note).
	//
	// Short timeout on purpose: this runs in a layout load that renders on
	// all four arm tabs, so it must never be the thing that stalls a page.
	// app.py:857-860 returns an *envelope* — `{"cameras": [...]}` — not a bare
	// array. Unwrap it here so callers get the array their types promise: the
	// generic on robotArmFetch is an unchecked cast, so getting this wrong is
	// invisible to `npm run check` and only shows up as a render-time
	// "cameras.find is not a function" 500.
	listCameras: async (): Promise<CameraStatus[]> => {
		const body = await robotArmFetch<{ cameras?: CameraStatus[] }>('/cameras', {
			timeoutMs: 3000
		});
		return Array.isArray(body?.cameras) ? body.cameras : [];
	},

	// One JPEG, whatever the worker's latest frame is. The Pi answers from a
	// slot rather than waiting on the camera, so this returns fast or not at
	// all; 4s is generous and keeps a wedged camera from pinning the function.
	getCameraSnapshot: (name: string) =>
		robotArmFetchBytes(`/cameras/${encodeURIComponent(name)}/snapshot.jpg`, {
			timeoutMs: 4000
		}),

	/**
	 * Depth (lidar) at points of a camera's COLOUR frame (ARM-04). Points are
	 * normalised [x, y] in 0..1 so the caller never needs the depth sensor's
	 * own resolution; the Pi maps each one onto the depth image and returns the
	 * median valid depth around it in millimetres (null where it has none).
	 *
	 * The route comes from services/robot-arm/src/server/depth.py, installed
	 * onto the live Pi by scripts/install_depth_router.py. A Pi without it
	 * answers FastAPI's bare 404 "Not Found" — that, and a camera with no depth
	 * sensor, both come back as `available: false`, never as an error: depth
	 * sharpens the marker check, it is not required for it.
	 */
	sampleDepth: async (name: string, points: [number, number][]): Promise<DepthSample> => {
		try {
			return await robotArmFetch<DepthSample>(`/cameras/${encodeURIComponent(name)}/depth/sample`, {
				method: 'POST',
				body: { points },
				timeoutMs: 4000
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/^robot-arm 404: Not Found/.test(msg)) {
				return {
					available: false,
					units: 'mm',
					depth_mm: points.map(() => null),
					reason: 'The Pi has no depth route installed yet (services/robot-arm/scripts/install_depth_router.py).'
				};
			}
			throw err;
		}
	},

	/**
	 * Exchange the API key for a short-lived, camera-only token the browser
	 * can put in a stream URL (ARM-02 mode B).
	 *
	 * The snapshot proxy above exists because the browser cannot authenticate
	 * to the Pi. This is the other half of that story: for viewers who *can*
	 * reach the Pi directly, one token turns the feed into a real MJPEG stream
	 * instead of a sequence of stills, at ~1 round trip instead of ~1 per frame.
	 *
	 * The API key still never leaves the server — only this token does, and it
	 * reads pixels, cannot move the arm, and expires in minutes (app.py's auth
	 * note covers the reasoning). Callers must treat the result as a credential:
	 * never log it, never cache it.
	 */
	mintStreamToken: () =>
		robotArmFetch<{ stream_token?: string; stream_token_expires_in_s?: number }>(
			'/cameras/auth',
			{ method: 'POST', timeoutMs: 4000 }
		)
};
