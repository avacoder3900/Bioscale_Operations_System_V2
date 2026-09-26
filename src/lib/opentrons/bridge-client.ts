/**
 * Browser → on-robot daemon client (OT2-TAILNET-5 §7.3, S5/S6 infrastructure).
 *
 * The daemon (scripts/ot2-bridge.py) serves its job endpoints on the robot's
 * own tailnet origin, `https://ot2-<slot>.tailf65a70.ts.net/bridge/…`, beside
 * the robot API. This client:
 *
 *   - takes a short-lived token from BIMS (GET /api/opentrons-lab/robots/{id}/bridge-token)
 *     and refreshes it before exp;
 *   - submits a job (the {kind, payload, jobId} a BIMS prepare route returned)
 *     — NEVER auto-retried, because a job start could run twice;
 *   - polls /bridge/jobs/{id} for live progress with no Vercel hop;
 *   - sends pause / resume / cancel, runs a test-scan, reads /bridge/health.
 *
 * It does not choose the line or talk to the robot API: the caller injects
 * `robotFetch(path, init)` — RobotSession.robotFetch on robot pages, or a plain
 * fetch to the robot's directUrl (plainRobotFetch) on the connectivity page.
 * Isomorphic: no DOM, no $lib/server, no Svelte.
 */

/** The daemon's queued job kinds (DIRECT_JOB_KINDS in ot2-bridge.py). */
export const BRIDGE_JOB_KINDS = [
	'sweep',
	'deck_scan',
	'calibrate_tip',
	'tip_swap_request',
	'restart_robot_server',
	'auto_resume_run'
] as const;
export type BridgeJobKind = (typeof BRIDGE_JOB_KINDS)[number];

/** Token scopes: the job kinds plus 'scan' (the /bridge/scan test-scan). */
export const BRIDGE_TOKEN_KINDS = [...BRIDGE_JOB_KINDS, 'scan'] as const;
export type BridgeTokenKind = (typeof BRIDGE_TOKEN_KINDS)[number];

export type BridgeJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export const BRIDGE_TERMINAL: readonly BridgeJobStatus[] = ['completed', 'failed', 'cancelled'];

/** What a BIMS tailnet-prepare route returns for the browser to submit. */
export interface BridgeJobDescriptor {
	jobId?: string;
	kind: BridgeJobKind;
	payload: Record<string, unknown>;
}

export interface BridgeJob {
	jobId: string;
	kind: BridgeJobKind;
	status: BridgeJobStatus;
	progress: {
		slotsDone: number;
		currentSlotIndex: number | null;
		scans: Array<Record<string, unknown>>;
		slotErrors: Array<Record<string, unknown>>;
		log: Array<{ ts: number; level: string; message: string }>;
		final: { status: string; abortReason?: string } | null;
		updates: number;
	};
	result: unknown;
	error: string | null;
	pauseRequested: boolean;
	cancelRequested: boolean;
	/** 0 = running now, n = n-th waiting, null = not in the queue. */
	queuePosition: number | null;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	requestedBy: string | null;
}

export interface BridgeScanResult {
	scanId: string;
	barcode: string | null;
	rawPayload: string | null;
	error: string | null;
	eventPosted: boolean;
}

export interface BridgeHealth {
	ok: boolean;
	service: 'ot2-bridge';
	version: string;
	jobServer: boolean;
	deviceId: string;
	robotId: string | null;
	heartbeat: Record<string, unknown> | null;
	heartbeatAgeS: number | null;
	serialOpen: boolean;
	serialPort: string | null;
	queue: { busy: { source: string; id: string; kind: string } | null; waiting: unknown[] };
}

/** Result of an UNAUTHENTICATED GET /bridge/health — is /bridge served at all? */
export interface BridgeProbe {
	/** true = the daemon answered; false = the origin answered but /bridge is not mounted; null = no answer. */
	served: boolean | null;
	state: 'ok' | 'auth-required' | 'disabled' | 'not-served' | 'unreachable';
	status?: number;
	latencyMs?: number;
	detail?: string;
}

export type RobotFetch = (path: string, init?: RequestInit & { timeoutMs?: number }) => Promise<Response>;

export type BridgeErrorCode =
	| 'unauthorized' // 401 from the daemon (or BIMS session gone)
	| 'forbidden' // 403: token scope / origin / BIMS permission
	| 'not_found' // 404: unknown job, or /bridge not served
	| 'conflict' // 409: control not possible now
	| 'disabled' // 503: daemon has no BRIDGE_TOKEN_SECRET
	| 'not_tailnet' // BIMS 409: robot not on the tailnet line here
	| 'token' // BIMS could not mint a token
	| 'network' // no answer from the robot
	| 'http' // any other status
	| 'timeout'
	| 'aborted';

export class BridgeError extends Error {
	constructor(
		message: string,
		readonly code: BridgeErrorCode,
		readonly status?: number,
		readonly body?: unknown
	) {
		super(message);
		this.name = 'BridgeError';
	}
}

export interface BridgeClientOptions {
	robotId: string;
	robotFetch: RobotFetch;
	/** Same-origin BIMS fetch (defaults to globalThis.fetch). */
	bimsFetch?: (input: string, init?: RequestInit) => Promise<Response>;
	/** Token scope to request. Default: every kind. [] = health-only token. */
	kinds?: readonly BridgeTokenKind[];
	/** Refresh this many seconds before exp (default 60). */
	refreshMarginS?: number;
	/** Test seams. */
	nowMs?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface BridgeClient {
	readonly robotId: string;
	/** A valid token, fetched or refreshed as needed. */
	token(): Promise<string>;
	invalidateToken(): void;
	/** Start a job. Never retried — on any failure the caller decides (e.g. getJob(jobId) to see if it landed). */
	submitJob(
		kind: BridgeJobKind,
		payload: Record<string, unknown>,
		opts?: { jobId?: string; timeoutMs?: number }
	): Promise<{ jobId: string; status: BridgeJobStatus; position: number | null; duplicate: boolean }>;
	/** submitJob for a BIMS prepare route's {kind, payload, jobId}. */
	submit(job: BridgeJobDescriptor): ReturnType<BridgeClient['submitJob']>;
	getJob(jobId: string): Promise<BridgeJob>;
	pollJob(
		jobId: string,
		onProgress?: (job: BridgeJob) => void,
		opts?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal; maxMisses?: number }
	): Promise<BridgeJob>;
	control(jobId: string, action: 'pause' | 'resume' | 'cancel'): Promise<BridgeJob>;
	/** One scanner test-scan (like a ScannerTrigger). Never retried. */
	testScan(opts?: { source?: string; contextRef?: string }): Promise<BridgeScanResult>;
	health(): Promise<{ latencyMs: number; body: BridgeHealth }>;
	/** No token: tells whether /bridge is served on this robot origin. */
	probe(timeoutMs?: number): Promise<BridgeProbe>;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

async function readJson(res: Response): Promise<any> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

function errorFor(status: number, body: any, what: string): BridgeError {
	const msg = (body && typeof body.error === 'string' && body.error) || `${what}: HTTP ${status}`;
	const code: BridgeErrorCode =
		status === 401
			? 'unauthorized'
			: status === 403
				? 'forbidden'
				: status === 404
					? 'not_found'
					: status === 409
						? 'conflict'
						: status === 503
							? 'disabled'
							: 'http';
	return new BridgeError(msg, code, status, body);
}

export function createBridgeClient(opts: BridgeClientOptions): BridgeClient {
	const { robotId, robotFetch } = opts;
	const bimsFetch = opts.bimsFetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
	const kinds = [...(opts.kinds ?? BRIDGE_TOKEN_KINDS)];
	const marginS = opts.refreshMarginS ?? 60;
	const nowMs = opts.nowMs ?? (() => Date.now());
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	let cached: { token: string; exp: number } | null = null;
	let pending: Promise<string> | null = null;

	async function fetchToken(): Promise<string> {
		const url = `/api/opentrons-lab/robots/${encodeURIComponent(robotId)}/bridge-token?kinds=${encodeURIComponent(kinds.join(','))}`;
		let res: Response;
		try {
			res = await bimsFetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
		} catch (e) {
			throw new BridgeError(`could not reach BIMS for a bridge token: ${e instanceof Error ? e.message : e}`, 'token');
		}
		const body = await readJson(res);
		if (!res.ok) {
			const msg = (body && (body.error || body.message)) || `bridge-token: HTTP ${res.status}`;
			const code: BridgeErrorCode =
				res.status === 409 ? 'not_tailnet' : res.status === 403 ? 'forbidden' : res.status === 401 ? 'unauthorized' : 'token';
			throw new BridgeError(String(msg), code, res.status, body);
		}
		if (typeof body?.token !== 'string' || typeof body?.exp !== 'number') {
			throw new BridgeError('bridge-token: malformed response', 'token', res.status, body);
		}
		cached = { token: body.token, exp: body.exp };
		return body.token;
	}

	async function token(): Promise<string> {
		if (cached && nowMs() / 1000 < cached.exp - marginS) return cached.token;
		if (!pending) pending = fetchToken().finally(() => (pending = null));
		return pending;
	}

	function invalidateToken() {
		cached = null;
	}

	/** One robot call with the bearer token. retry401: re-mint + retry ONCE (reads/control only). */
	async function call(
		path: string,
		init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs?: number },
		retry401: boolean
	): Promise<{ res: Response; body: any }> {
		const send = async (tok: string) => {
			try {
				return await robotFetch(path, {
					method: init.method,
					headers: { authorization: `Bearer ${tok}`, ...(init.body !== undefined ? JSON_HEADERS : {}) },
					body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
					timeoutMs: init.timeoutMs
				});
			} catch (e) {
				throw new BridgeError(
					`robot did not answer ${init.method} ${path}: ${e instanceof Error ? e.message : e}`,
					'network'
				);
			}
		};
		let res = await send(await token());
		if (res.status === 401) {
			invalidateToken(); // a stale/rotated token: the NEXT call mints a fresh one either way
			if (retry401) res = await send(await token());
		}
		return { res, body: await readJson(res) };
	}

	async function submitJob(
		kind: BridgeJobKind,
		payload: Record<string, unknown>,
		o?: { jobId?: string; timeoutMs?: number }
	) {
		const { res, body } = await call(
			'/bridge/jobs',
			{ method: 'POST', body: { kind, payload, ...(o?.jobId ? { jobId: o.jobId } : {}) }, timeoutMs: o?.timeoutMs ?? 15_000 },
			false
		);
		if (!res.ok) throw errorFor(res.status, body, `submit ${kind}`);
		return {
			jobId: String(body.jobId),
			status: body.status as BridgeJobStatus,
			position: typeof body.position === 'number' ? body.position : null,
			duplicate: !!body.duplicate
		};
	}

	async function getJob(jobId: string): Promise<BridgeJob> {
		const { res, body } = await call(`/bridge/jobs/${encodeURIComponent(jobId)}`, { method: 'GET', timeoutMs: 10_000 }, true);
		if (!res.ok) throw errorFor(res.status, body, `job ${jobId}`);
		return body as BridgeJob;
	}

	async function pollJob(
		jobId: string,
		onProgress?: (job: BridgeJob) => void,
		o?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal; maxMisses?: number }
	): Promise<BridgeJob> {
		const intervalMs = o?.intervalMs ?? 1000;
		const maxMisses = o?.maxMisses ?? 5;
		const t0 = nowMs();
		let misses = 0;
		for (;;) {
			if (o?.signal?.aborted) throw new BridgeError('polling aborted', 'aborted');
			try {
				const job = await getJob(jobId);
				misses = 0;
				onProgress?.(job);
				if (BRIDGE_TERMINAL.includes(job.status)) return job;
			} catch (e) {
				// A dropped poll is not a failed job — the job keeps running on the
				// robot and still reports to BIMS. Tolerate a few in a row.
				if (!(e instanceof BridgeError) || e.code !== 'network' || ++misses > maxMisses) throw e;
			}
			if (o?.timeoutMs && nowMs() - t0 > o.timeoutMs) {
				throw new BridgeError(`job ${jobId} not finished after ${o.timeoutMs} ms`, 'timeout');
			}
			await sleep(intervalMs);
		}
	}

	async function control(jobId: string, action: 'pause' | 'resume' | 'cancel'): Promise<BridgeJob> {
		const { res, body } = await call(
			`/bridge/jobs/${encodeURIComponent(jobId)}/control`,
			{ method: 'POST', body: { action }, timeoutMs: 10_000 },
			true
		);
		if (!res.ok) throw errorFor(res.status, body, `${action} ${jobId}`);
		return body as BridgeJob;
	}

	async function testScan(o?: { source?: string; contextRef?: string }): Promise<BridgeScanResult> {
		const { res, body } = await call('/bridge/scan', { method: 'POST', body: { ...(o ?? {}) }, timeoutMs: 30_000 }, false);
		if (!res.ok) throw errorFor(res.status, body, 'test-scan');
		return body as BridgeScanResult;
	}

	async function health(): Promise<{ latencyMs: number; body: BridgeHealth }> {
		const t0 = nowMs();
		const { res, body } = await call('/bridge/health', { method: 'GET', timeoutMs: 5_000 }, true);
		if (!res.ok) throw errorFor(res.status, body, 'bridge health');
		return { latencyMs: Math.round(nowMs() - t0), body: body as BridgeHealth };
	}

	async function probe(timeoutMs = 3000): Promise<BridgeProbe> {
		const t0 = nowMs();
		let res: Response;
		try {
			res = await robotFetch('/bridge/health', { method: 'GET', timeoutMs });
		} catch (e) {
			return { served: null, state: 'unreachable', detail: e instanceof Error ? e.message : String(e) };
		}
		const latencyMs = Math.round(nowMs() - t0);
		const body = await readJson(res);
		const daemon = body && body.service === 'ot2-bridge';
		if (res.ok && daemon) return { served: true, state: 'ok', status: res.status, latencyMs };
		if ((res.status === 401 || res.status === 403) && daemon) {
			return { served: true, state: 'auth-required', status: res.status, latencyMs };
		}
		if (res.status === 503 && daemon) {
			return { served: true, state: 'disabled', status: res.status, latencyMs, detail: body.error };
		}
		// Anything else is the robot API (or Tailscale) answering for a path it
		// does not know: /bridge is not mounted on this origin.
		return { served: false, state: 'not-served', status: res.status, latencyMs };
	}

	return {
		robotId,
		token,
		invalidateToken,
		submitJob,
		submit: (job) => submitJob(job.kind, job.payload, { jobId: job.jobId }),
		getJob,
		pollJob,
		control,
		testScan,
		health,
		probe
	};
}

/**
 * A RobotFetch straight to a robot origin (https://ot2-<slot>.tailf65a70.ts.net),
 * with a timeout and no line logic — for the connectivity page's probes. Robot
 * pages use RobotSession.robotFetch instead (tracked, failover-aware).
 */
export function plainRobotFetch(
	baseUrl: string,
	fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (i, n) => globalThis.fetch(i, n)
): RobotFetch {
	const base = baseUrl.replace(/\/+$/, '');
	return (path, init) => {
		const { timeoutMs, ...rest } = init ?? {};
		return fetchImpl(`${base}${path}`, {
			...rest,
			signal: rest.signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined)
		});
	};
}
