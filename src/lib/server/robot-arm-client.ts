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

// The Pi heartbeats its tunnel URL every 5 min. A row older than this is
// "stale": usually the tunnel (or the Pi) is gone, so it is no longer tried
// first. But the heartbeat can fail while the tunnel itself is fine (2026-10-20:
// the office DNS died, the Pi could not resolve BIMS for 8 h, and the arm showed
// unreachable while its tunnel answered). So a stale row is still tried, last,
// after the Funnel, up to TUNNEL_STALE_MAX_AGE_MS. A dead quick-tunnel URL fails
// fast (NXDOMAIN or Cloudflare 530), so the cost is one quick failed attempt.
const TUNNEL_MAX_AGE_MS = 15 * 60 * 1000;
const TUNNEL_STALE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const TUNNEL_CACHE_MS = 30_000;

// Retry limit (option D). Attempts alternate between routes and all share the
// caller's single timeoutMs budget, so a retry can never push a page past the
// adapter's 30 s maxDuration.
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 300;

interface TunnelRoute {
	url: string;
	fresh: boolean;
}

let tunnelCache: { route: TunnelRoute | null; at: number } | null = null;
let lastGoodRoute: string | null = null;

export function invalidateTunnelCache(): void {
	tunnelCache = null;
}

async function tunnelRoute(): Promise<TunnelRoute | null> {
	if (tunnelCache && Date.now() - tunnelCache.at < TUNNEL_CACHE_MS) return tunnelCache.route;
	let route: TunnelRoute | null = null;
	try {
		await connectDB();
		const row = (await RobotArmEndpoint.findById('tunnel').lean()) as {
			url?: string;
			registeredAt?: Date;
		} | null;
		const age = row?.registeredAt ? Date.now() - new Date(row.registeredAt).getTime() : Infinity;
		if (row?.url && age < TUNNEL_STALE_MAX_AGE_MS) {
			route = { url: row.url, fresh: age < TUNNEL_MAX_AGE_MS };
		}
	} catch {
		// A DB hiccup must not take the arm down with it; use the Funnel alone.
		route = null;
	}
	tunnelCache = { route, at: Date.now() };
	return route;
}

async function armRoutes(): Promise<string[]> {
	const routes: string[] = [];
	const tunnel = await tunnelRoute();
	if (tunnel?.fresh) routes.push(tunnel.url);
	const funnel = env.ROBOT_ARM_BASE_URL?.replace(/\/$/, '');
	if (funnel) routes.push(funnel);
	if (tunnel && !tunnel.fresh) routes.push(tunnel.url);
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

// GET /servos — raw follower state per servo (no IK needed). `load` is the
// STS3215's signed present load (~±1000); `position` is the same raw encoder
// step /pose reports as joint_steps.
export interface ServoState {
	id: number;
	position: number;
	speed: number;
	load: number;
	voltage: number;
	temperature: number;
	torque: boolean;
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
	/** Resolved V4L2 node even while idle (cameras.py peek_device, sysfs only). */
	device: string | null;
	/** idle = node found, worker not started (starts on the first snapshot/stream request, never on a status poll). Absent on a cameras.py older than 2026-10-22. */
	state?: 'running' | 'idle' | 'absent' | 'error';
	running: boolean;
	requested: { width: number; height: number; fps: number; quality: number };
	/** [h, w, channels] of the last decoded frame; null before the first frame. */
	actual_size: number[] | null;
	frames: number;
	last_frame_age_s: number | null;
	stale: boolean;
	error: string | null;
}

// GET /health/thermal — mirrors robot-arm/src/server/thermal.py: SoC
// temperature, the firmware's throttle flags (now / since boot), clock and
// the service's own CPU use. `level` is the Pi's own summary.
export interface ArmThermal {
	temp_c: number | null;
	level: 'ok' | 'warm' | 'hot' | 'critical';
	throttled_hex: string | null;
	/** Active right now: 'throttled' | 'freq_capped' | 'soft_temp_limit' | 'under_voltage'. */
	now: string[];
	/** Same names with `_occurred`: ever, since boot. */
	since_boot: string[];
	clock_mhz: number | null;
	clock_max_mhz: number | null;
	load_1m: number | null;
	/** This service's CPU use since the previous sample, % of one core (threads add up). */
	service_cpu_pct: number | null;
	fan_rpm: number | null;
	uptime_s: number | null;
	thresholds: { warm_c: number; hot_c: number; critical_c: number };
	/** Which Wi-Fi the Pi is on (nmcli on the Pi). Absent from a thermal.py older than 2026-10-22. */
	network?: ArmNetwork | null;
	sampled_at: number;
}

// GET /arm/health — mirrors app.py arm_health(): every follower servo with
// the Pi's own derived flags. Reads the serial bus (list_states + get_torques),
// so it is polled from the browser, never from a layout load.
export interface ArmJointHealth {
	id: number;
	position: number;
	load: number;
	speed: number;
	voltage: number;
	/** °C as the STS3215 reports it (whole degrees). */
	temperature: number;
	torque: boolean;
	/** 'hot' | 'warm' | 'high_load' | 'undervolt' | 'overvolt' | 'torque_off'. */
	flags: string[];
}

export interface ArmHealth {
	overall: 'ok' | 'warn' | 'fault';
	joints: ArmJointHealth[];
	leader_alive: boolean;
	follower_alive: boolean;
	thresholds: {
		temp_warm_c: number;
		temp_hot_c: number;
		load_high: number;
		voltage_low: number;
		voltage_high: number;
	};
}

export interface ArmNetwork {
	iface: string;
	/** null when the interface is up but not associated, or nmcli could not be read (see source). */
	ssid: string | null;
	/** NetworkManager connection profile name (e.g. netplan-wlan0-Fannin_WIFI). */
	connection: string | null;
	signal_pct: number | null;
	freq_mhz: number | null;
	ip: string | null;
	/** ARM_WIFI_EXPECTED_SSID in the Pi's .env; the chip turns amber when ssid differs. */
	expected_ssid: string | null;
	/** 'nmcli', or 'unavailable: <reason>'. */
	source: string | null;
}

// AprilTag detection, mirroring robot-arm/src/server/apriltags.py (ARM-05).
export interface AprilTagDetectRequest {
	/** tag id → black-square edge, mm. Tags without a size come back with pose null. */
	tag_sizes_mm?: Record<string, number>;
	default_size_mm?: number | null;
	include_frame?: boolean;
	depth?: boolean;
	/** Distinct consecutive frames to average each tag's corners over (1..10; the Pi's default is 1). */
	frames?: number;
}

export interface AprilTagDetectResponse {
	available: boolean;
	reason: string | null;
	family?: string;
	detector?: string;
	/** Corner refinement in use: 'apriltag' (default since 2026-10-23), 'subpix' or 'none'. */
	refine?: string;
	upscale?: number;
	frame?: { width: number; height: number };
	/** 'raw' = detected on the sensor's own luma (cameras.current()); 'jpeg' = decoded from the snapshot route (older Pi). */
	frame_source?: 'raw' | 'jpeg';
	frames_used?: number;
	intrinsics?: { fx: number; fy: number; cx: number; cy: number; dist?: number[]; source: 'realsense' | 'env' | 'nominal' };
	tags: {
		id: number;
		/** Normalised [x, y]. */
		center: [number, number];
		/** Normalised, tag order TL, TR, BR, BL. */
		corners: [number, number][];
		size_mm: number | null;
		/**
		 * Camera frame (x right, y down, z out of the lens): t in mm, R row-major.
		 * `alt` is the solver's other planar pose (toward/away ambiguity) when it has one.
		 */
		pose: { t_mm: [number, number, number]; R: number[]; reproj_px: number; alt?: { t_mm: [number, number, number]; R: number[]; reproj_px: number } | null } | null;
		depth_mm: number | null;
		margin: number | null;
		/** Frames (of frames_used) this tag was seen in; absent from a Pi before 2026-10-23. */
		frames_seen?: number;
		/** Mean standard deviation of the 8 corner coordinates across those frames, px; null with one frame. */
		jitter_px?: number | null;
	}[];
	/** The exact JPEG the tags were found in, when include_frame was set. */
	frame_jpeg_b64?: string;
	elapsed_ms?: number;
}

// UVC camera controls, mirroring robot-arm/src/server/camera_controls.py.
// Every range here is what the camera itself reports through v4l2-ctl; BIMS
// never invents a limit.
export interface CameraControl {
	/** v4l2 control name, e.g. exposure_time_absolute. */
	id: string;
	type: 'int' | 'bool' | 'menu';
	min: number | null;
	max: number | null;
	step: number | null;
	default: number | null;
	value: number | null;
	/** Menu label of the current value, when the control is a menu. */
	value_label: string | null;
	/** v4l2 flags, e.g. 'inactive' while an auto switch gates this control. */
	flags: string[];
	/** Menu index → label, for menu controls. */
	menu: Record<string, string> | null;
	/** Unit of the raw value ('x100 us', 'K', ...) or ''. */
	unit: string;
	hint: string;
}

export interface CameraControlsResponse {
	available: boolean;
	reason: string | null;
	camera: string;
	device: string | null;
	source: string;
	controls: CameraControl[];
	/** The set re-applied by the Pi on every device open (calibrations/camera_controls.json). */
	saved: Record<string, number>;
	saved_file: string;
	applied?: string[];
	rejected?: Record<string, string>;
}

// Depth stream mode, mirroring depth.py GET/POST /depth/config (2026-10-23).
export interface DepthStreamStatus {
	device: string | null;
	running: boolean;
	mode: string;
	width: number;
	height: number;
	fps: number;
	measured_fps: number | null;
	frame_bytes: number;
	frames: number;
	last_frame_age_s: number | null;
	stale: boolean;
	child_pid: number | null;
	/** The v4l2-ctl reader child's CPU since the previous status read, % of one core. */
	child_cpu_pct: number | null;
	error: string | null;
}

export interface DepthConfig {
	mode: '480p' | '720p';
	width: number;
	height: number;
	fps: number;
	modes: Record<string, [number, number]>;
	fps_choices: number[];
	persisted: boolean;
	file: string;
	status: DepthStreamStatus;
	changed?: boolean;
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
	listServos: () => robotArmFetch<ServoState[]>('/servos'),
	// sysfs + vcgencmd only; touches no bus. 404 until install_thermal_router.py has run on the Pi.
	/**
	 * listServos with one retry on a 5xx after a short pause. The Pi's
	 * one-shot routes used to open the serial port concurrently (two GET
	 * /servos in the same instant → pyserial "multiple access on port" → 500,
	 * seen 2026-10-22 while capturing a pose reference during the editor's
	 * poll). The Pi now serialises them (bus_lock.py); this covers a Pi
	 * without that installed and any other one-off bus hiccup.
	 */
	listServosRetry: async (): Promise<ServoState[]> => {
		try {
			return await robotArm.listServos();
		} catch (err) {
			if (!/robot-arm 5\d\d/.test((err as Error).message ?? '')) throw err;
			await new Promise((r) => setTimeout(r, 400));
			return robotArm.listServos();
		}
	},
	getThermal: (opts: { timeoutMs?: number } = {}) => robotArmFetch<ArmThermal>('/health/thermal', { timeoutMs: opts.timeoutMs ?? 3000 }),
	// Per-servo temperature / load / voltage with the Pi's flags. Touches the bus. 503 while the follower is not connected.
	getHealth: (opts: { timeoutMs?: number } = {}) => robotArmFetch<ArmHealth>('/arm/health', { timeoutMs: opts.timeoutMs ?? 4000 }),
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
	/**
	 * Torque back on WITHOUT a jump (ARM-06): the Pi writes goal = present on
	 * every servo, then enables torque — the driver's pause(). Used after the
	 * operator posed the arm by hand with torque off; a bare setTorque(true)
	 * would drive every servo back to its last goal. Route from
	 * services/robot-arm/src/server/hold.py (scripts/install_hold_router.py).
	 */
	holdServos: () =>
		robotArmFetch<{ held: boolean; positions: Record<string, number> }>('/servos/hold', { method: 'POST', timeoutMs: 8000 }),
	setTorque: (enable: boolean) =>
		robotArmFetch<{ enabled: boolean }>('/torque', { method: 'POST', body: { enable } }),
	jogJoint: (sid: number, delta_steps: number, speed?: number) =>
		robotArmFetch<{ id: number; goal: number }>(`/servos/${sid}/jog`, {
			method: 'POST',
			body: { delta_steps, ...(speed !== undefined ? { speed } : {}) }
		}),
	/**
	 * Set one servo's goal to an ABSOLUTE position (Animate's live sliders).
	 * Unlike jogJoint (goal = wherever the servo is right now + delta) the
	 * result does not depend on where the arm happened to be, so the same
	 * value always sends the servo to the same place. No speed is sent: the
	 * Goal_Speed register persists on the servo and would slow later replays.
	 * 409 when that servo's torque is off.
	 */
	moveJoint: (sid: number, position: number) =>
		robotArmFetch<{ id: number; goal: number }>(`/servos/${sid}/move`, {
			method: 'POST',
			body: { position: Math.round(position) }
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
	 * Every AprilTag 36h11 tag in the camera's current frame (ARM-05), with its
	 * pose in mm where the tag's size is given, the D415 depth at its centre
	 * when depth.py is installed, and optionally the JPEG it was found in.
	 *
	 * The route comes from services/robot-arm/src/server/apriltags.py, installed
	 * onto the live Pi by scripts/install_apriltag_router.py. A Pi without it
	 * answers FastAPI's bare 404 "Not Found"; that comes back as
	 * `available: false` with a reason saying what to install. The Pi itself
	 * also answers `available: false` (never an HTTP error) when it has no
	 * frame or no OpenCV aruco.
	 */
	detectAprilTags: async (name: string, req: AprilTagDetectRequest): Promise<AprilTagDetectResponse> => {
		try {
			return await robotArmFetch<AprilTagDetectResponse>(`/cameras/${encodeURIComponent(name)}/apriltags/detect`, {
				method: 'POST',
				body: req,
				timeoutMs: 8000
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/^robot-arm 404: Not Found/.test(msg)) {
				return {
					available: false,
					tags: [],
					reason: 'The Pi has no AprilTag route installed yet (services/robot-arm/scripts/install_apriltag_router.py).'
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
		),

	// --- Camera controls + depth stream mode (2026-10-23) -------------------
	//
	// camera_controls.py and the depth.py config routes are installed by
	// scripts/install_vision_quality.py. A Pi without them answers 404, which
	// the BIMS routes turn into `installed: false` rather than an error.
	getCameraControls: (name: string) =>
		robotArmFetch<CameraControlsResponse>(`/cameras/${encodeURIComponent(name)}/controls`, { timeoutMs: 6000 }),
	setCameraControls: (name: string, set: Record<string, number>, persist = true) =>
		robotArmFetch<CameraControlsResponse>(`/cameras/${encodeURIComponent(name)}/controls`, {
			method: 'POST',
			body: { set, persist },
			timeoutMs: 8000
		}),
	resetCameraControls: (name: string, persist = true) =>
		robotArmFetch<CameraControlsResponse>(`/cameras/${encodeURIComponent(name)}/controls/reset`, {
			method: 'POST',
			body: { persist },
			timeoutMs: 8000
		}),
	getDepthConfig: () => robotArmFetch<DepthConfig>('/depth/config', { timeoutMs: 4000 }),
	setDepthConfig: (body: { mode?: '480p' | '720p'; fps?: number; persist?: boolean }) =>
		robotArmFetch<DepthConfig>('/depth/config', { method: 'POST', body, timeoutMs: 8000 })
};
