/**
 * Browser-side robot session (OT2-TAILNET-4).
 *
 * A page opens ONE session per robot. The session decides, once, which line
 * this page uses to reach the robot, and every call goes that way:
 *
 *   direct  the browser calls https://ot2-<slot>.tailf65a70.ts.net itself
 *           (robot record says 'tailnet', this deployment allows it, AND this
 *           computer can reach it — proven by a /health probe)
 *   queue   the browser calls the BIMS API route, which uses the Vercel queue
 *           (exactly today's behaviour)
 *
 * No silent mixing: if a direct call gets no answer (network down, tailnet off),
 * the session switches to the queue FOR THE REST OF THE PAGE, says so
 * (`fellBack`), and retries that one call through BIMS. It never switches back
 * on its own — only retryDirect() (an operator click) or a reload does.
 * A robot HTTP error (4xx/5xx) is the robot answering, not a line failure.
 *
 * Every call returns a Response with the same status + JSON body the BIMS route
 * would have returned (both lines run $lib/opentrons/ot2-protocol runVerb), so
 * components keep their existing response handling.
 *
 * robotFetch() (OT2-TAILNET-5) is the raw, tracked robot request the isomorphic
 * robot-client (openapi-fetch) runs over: direct → the robot origin; queue (or
 * after a fallback) → the BIMS relay, which runs one queue command.
 */
import {
	DEFINITION_VERBS,
	MOTION_VERBS,
	NO_RETRY_VERBS,
	browserTransport,
	maintenanceRecordFor,
	runVerb,
	verbRoute,
	type Ot2Transport,
	type Ot2Verb
} from './ot2-protocol';

export type SessionTransport = 'direct' | 'queue';

export interface RobotSessionState {
	robotId: string;
	/** 'opening' until the first decision is made. */
	transport: SessionTransport | 'opening';
	/** Human-readable why — shown as the pill tooltip. */
	reason: string;
	/** A daemon job holding the gantry (sweep / deck scan / tip calibrate), if any. */
	busy: { kind: string; since: string } | null;
	/** True once a direct call failed and the session moved to the queue. */
	fellBack: boolean;
	/** Robot is set up for tailnet (so "Retry direct" is meaningful). */
	tailnetConfigured: boolean;
	/**
	 * Chrome's Local Network Access permission for THIS BIMS origin. A public site
	 * (vercel.app) reaching a private address (Tailscale 100.x) needs a one-time
	 * "allow" per origin; until granted, Chrome holds the request, which looks
	 * exactly like an unreachable robot. 'unsupported' = browser has no such gate.
	 */
	browserPermission?: LocalNetworkPermission;
	/** The operator must click "allow direct" (a user gesture) to grant it. */
	needsPermission?: boolean;
	/** DECK_HARDENING_ROBOT_IDS status from BIMS — the labware reuse rule. */
	hardened?: boolean;
	directUrl?: string;
	/** Latency of the last successful direct probe/call, ms. */
	latencyMs?: number;
	/**
	 * Which verbs this page actually ran on each line (first use order) — the
	 * pill tooltip lists them. Raw robot calls appear as 'raw:GET /health'.
	 */
	usedVia?: { tailscale: string[]; queue: string[] };
}

export type LocalNetworkPermission = 'granted' | 'prompt' | 'denied' | 'unsupported';

/** Chrome ≥ 142 gates public-site → private-network requests behind a permission. */
export async function queryLocalNetworkPermission(): Promise<LocalNetworkPermission> {
	const perms = typeof navigator !== 'undefined' ? (navigator as any).permissions : undefined;
	if (!perms?.query) return 'unsupported';
	for (const name of ['local-network-access', 'local-network']) {
		try {
			const st = (await perms.query({ name })).state;
			if (st === 'granted' || st === 'prompt' || st === 'denied') return st;
		} catch {
			/* unknown permission name in this browser — try the next */
		}
	}
	return 'unsupported';
}

export interface DirectCallRow {
	sessionId: string;
	verb: string;
	method: string;
	path: string;
	status: number;
	ok: boolean;
	latencyMs: number;
	error?: string;
	at: string;
}

export interface SessionOptions {
	fetchImpl?: typeof fetch;
	/** /health probe timeout (default 1500 ms). */
	probeTimeoutMs?: number;
	/** How often to re-read /connection while direct (busy + kill switch). 0 disables. */
	refreshMs?: number;
	/** How often to flush the direct-call log. 0 = flush only on close(). */
	flushMs?: number;
	/** Injectable for tests; defaults to queryLocalNetworkPermission. */
	permissionQuery?: () => Promise<LocalNetworkPermission>;
}

const API = (robotId: string) => `/api/opentrons-lab/robots/${encodeURIComponent(robotId)}`;

/** The maintenance routes a session can serve on the robot's line. */
const MX_OPEN = /^\/api\/opentrons-lab\/robots\/([^/?#]+)\/maintenance$/;
const MX_RUN = /^\/api\/opentrons-lab\/robots\/([^/?#]+)\/maintenance\/([^/?#]+)$/;
const MX_ROUTE = /^\/api\/opentrons-lab\/robots\/([^/?#]+)\/maintenance\/([^/?#]+)\/(jog|position|move-to|move-to-well|home|drop-tip|load-labware|pick-up-tip)$/;
const MX_VERB: Record<string, Ot2Verb> = {
	jog: 'mx.jog',
	position: 'mx.position',
	'move-to': 'mx.moveTo',
	'move-to-well': 'mx.moveToWell',
	home: 'mx.home',
	'drop-tip': 'mx.dropTip',
	'load-labware': 'mx.loadLabware',
	'pick-up-tip': 'mx.pickUpTip'
};

/** Map a BIMS maintenance route to its shared verb, or null (= a plain BIMS fetch). */
export function routeToVerb(path: string, method = 'GET'): { robotId: string; runId?: string; verb: Ot2Verb } | null {
	const m = method.toUpperCase();
	const dec = decodeURIComponent;
	let hit: RegExpExecArray | null;
	if (m === 'POST' && (hit = MX_OPEN.exec(path))) return { robotId: dec(hit[1]), verb: 'mx.open' };
	if (m === 'DELETE' && (hit = MX_RUN.exec(path))) return { robotId: dec(hit[1]), runId: dec(hit[2]), verb: 'mx.close' };
	if (m === 'POST' && (hit = MX_ROUTE.exec(path))) return { robotId: dec(hit[1]), runId: dec(hit[2]), verb: MX_VERB[hit[3]] };
	return null;
}

/** Fields the browser adds for the robot half; never sent to a BIMS route. */
const LINE_ONLY_ARGS = ['rid', 'runId', 'definition', 'labwareNamespace', 'labwareVersion', 'hardened'];

/**
 * How the no-retry message names the action. Keyed by string so verbs added to
 * NO_RETRY_VERBS later (run.create, run.uploadProtocol, mx.command) read well
 * without this file importing names that may not exist yet.
 */
const NO_RETRY_WHAT: Record<string, string> = {
	'mx.jog': 'jog',
	'mx.pickUpTip': 'tip pick-up',
	'run.create': 'run creation',
	'run.uploadProtocol': 'protocol upload',
	'mx.command': 'maintenance command'
};
export function noRetryLabel(verb: string): string {
	return NO_RETRY_WHAT[verb] ?? (verb.startsWith('raw:') ? `robot request (${verb.slice(4)})` : verb);
}
function noRetryMessage(verb: string): string {
	return `Direct link to the robot was lost during this ${noRetryLabel(verb)}. It was NOT retried (it may have happened). Check the robot, then try again — now via BIMS.`;
}

/** Init for RobotSession.robotFetch: a fetch init plus a transport timeout. */
export type RobotFetchInit = RequestInit & { timeoutMs?: number };

const RAW_DEFAULT_TIMEOUT_MS = 30_000;
const USED_VIA_MAX = 40;

/**
 * '/runs/3f2a…/actions?x=1' → '/runs/:id/actions'. A segment counts as an id
 * when it has a digit and is ≥ 8 chars (uuids, nanoids, robot hashes).
 */
export function rawPathTemplate(path: string): string {
	const bare = path.split(/[?#]/)[0];
	return bare
		.split('/')
		.map((seg) => (seg.length >= 8 && /\d/.test(seg) ? ':id' : seg))
		.join('/');
}

/** The /direct-calls verb for a raw call: 'raw:' + METHOD + ' ' + template, ≤ 40 chars. */
export function rawVerbLabel(method: string, path: string): string {
	return `raw:${method.toUpperCase()} ${rawPathTemplate(path)}`.slice(0, 40);
}

function isBinaryBody(body: unknown): boolean {
	if (body == null || typeof body === 'string') return false;
	if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
	if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
	if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return true;
	if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true;
	return true; // anything else is not a JSON string — the relay can't carry it
}

/** A caller asking for a non-JSON answer (a log file, a download) needs the direct line. */
function wantsBinaryAnswer(headers: Headers): boolean {
	const accept = headers.get('accept');
	return !!accept && !/json|\*\/\*/i.test(accept);
}

function newSessionId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body ?? null), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/** Combine the caller's signal with a transport timeout where the browser supports it. */
function withCallerSignal(own: AbortSignal, caller?: AbortSignal): AbortSignal {
	if (!caller) return own;
	const any = (AbortSignal as any).any as ((s: AbortSignal[]) => AbortSignal) | undefined;
	return any ? any([own, caller]) : own;
}

export class RobotSession {
	readonly robotId: string;
	readonly sessionId = newSessionId();
	private readonly fetchImpl: typeof fetch;
	private readonly opts: Required<Omit<SessionOptions, 'fetchImpl' | 'permissionQuery'>>;
	private readonly permissionQuery: () => Promise<LocalNetworkPermission>;
	private _state: RobotSessionState;
	private listeners = new Set<(s: RobotSessionState) => void>();
	private log: DirectCallRow[] = [];
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private closed = false;
	private onPageHide = () => void this.flush(true);

	constructor(robotId: string, options: SessionOptions = {}) {
		this.robotId = robotId;
		this.fetchImpl = options.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
		this.permissionQuery = options.permissionQuery ?? queryLocalNetworkPermission;
		this.opts = {
			probeTimeoutMs: options.probeTimeoutMs ?? 1500,
			refreshMs: options.refreshMs ?? 5000,
			flushMs: options.flushMs ?? 3000
		};
		this._state = {
			robotId,
			transport: 'opening',
			reason: 'checking connection…',
			busy: null,
			fellBack: false,
			tailnetConfigured: false
		};
	}

	get state(): RobotSessionState {
		return this._state;
	}

	/** Subscribe to state changes; called immediately with the current state. */
	subscribe(fn: (s: RobotSessionState) => void): () => void {
		this.listeners.add(fn);
		fn(this._state);
		return () => this.listeners.delete(fn);
	}

	private set(patch: Partial<RobotSessionState>) {
		this._state = { ...this._state, ...patch };
		for (const fn of this.listeners) fn(this._state);
	}

	/** Decide the line for this page. Never throws — any doubt means queue. */
	async open(): Promise<RobotSessionState> {
		let conn: any = null;
		try {
			const res = await this.fetchImpl(`${API(this.robotId)}/connection`);
			if (res.ok) conn = await res.json();
		} catch {
			/* fall through to queue */
		}
		if (!conn || conn.transport !== 'tailnet' || !conn.directUrl) {
			this.set({
				transport: 'queue',
				reason: conn?.reason ?? 'queue — connection info unavailable',
				busy: conn?.busy ?? null,
				tailnetConfigured: false
			});
			return this._state;
		}
		this.set({ tailnetConfigured: true, directUrl: conn.directUrl, busy: conn.busy ?? null, hardened: conn.hardened === true });
		if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide);
		const perm = await this.permissionQuery();
		this.set({ browserPermission: perm });
		if (perm === 'prompt') {
			// Probing now would just hang behind a permission prompt Chrome won't show
			// without a click. Stay on the queue and offer the button.
			this.set({
				transport: 'queue',
				needsPermission: true,
				reason: 'queue — this browser needs a one-time permission to reach the robot on Tailscale (click "allow direct")'
			});
			return this._state;
		}
		if (perm === 'denied') {
			this.set({
				transport: 'queue',
				reason: 'queue — this browser blocked local-network access for BIMS (site settings → Local network access → Allow, then reload)'
			});
			return this._state;
		}
		await this.probeAndSet(conn.directUrl);
		return this._state;
	}

	private async probeAndSet(directUrl: string, timeoutMs = this.opts.probeTimeoutMs) {
		const t0 = Date.now();
		try {
			const res = await this.fetchImpl(`${directUrl}/health`, {
				headers: { 'opentrons-version': '3' },
				signal: AbortSignal.timeout(timeoutMs)
			});
			if (!res.ok) throw new Error(`robot /health returned ${res.status}`);
			this.set({
				transport: 'direct',
				fellBack: false,
				needsPermission: false,
				latencyMs: Date.now() - t0,
				reason: 'direct — this browser talks to the robot over Tailscale'
			});
			this.startTimers();
		} catch (e) {
			this.set({
				transport: 'queue',
				reason: `queue — robot is on Tailscale but this computer can't reach it (${e instanceof Error ? e.message : 'probe failed'})`
			});
		}
	}

	/**
	 * Operator-initiated (call it from a click): try the direct line again after a
	 * fallback, or grant the browser's local-network permission. When a permission
	 * answer is pending, wait long enough for the operator to click Allow.
	 */
	async retryDirect(): Promise<RobotSessionState> {
		if (!this._state.directUrl) return this._state;
		const waitForPrompt = this._state.browserPermission === 'prompt';
		await this.probeAndSet(this._state.directUrl, waitForPrompt ? 60_000 : this.opts.probeTimeoutMs);
		const perm = await this.permissionQuery();
		this.set({ browserPermission: perm, needsPermission: perm === 'prompt' && this._state.transport !== 'direct' });
		return this._state;
	}

	private startTimers() {
		if (this.opts.refreshMs && !this.refreshTimer) {
			this.refreshTimer = setInterval(() => void this.refresh(), this.opts.refreshMs);
		}
		if (this.opts.flushMs && !this.flushTimer) {
			this.flushTimer = setInterval(() => void this.flush(), this.opts.flushMs);
		}
	}

	/** Re-read /connection: busy flag, and the per-robot kill switch (mode → queue). */
	private async refresh() {
		if (this._state.transport !== 'direct') return;
		try {
			const res = await this.fetchImpl(`${API(this.robotId)}/connection`);
			if (!res.ok) return;
			const conn = await res.json();
			if (conn.transport !== 'tailnet') {
				this.set({ transport: 'queue', fellBack: true, busy: conn.busy ?? null, reason: conn.reason });
				return;
			}
			this.set({ busy: conn.busy ?? null, hardened: conn.hardened === true });
		} catch {
			/* a missed refresh changes nothing */
		}
	}

	private fallBack(reason: string) {
		this.set({ transport: 'queue', fellBack: true, reason: `queue (fell back) — ${reason}` });
	}

	/**
	 * Run a verb on this robot. `args` = the route's path params (rid / runId)
	 * plus its JSON body fields. Returns what the BIMS route returns — including
	 * the BIMS half (audit row, tip cursor) when the robot half ran directly.
	 */
	async call(verb: Ot2Verb, args: Record<string, unknown>, init: { signal?: AbortSignal } = {}): Promise<Response> {
		const s = this._state;
		const motionWhileBusy = MOTION_VERBS.has(verb) && !!s.busy;
		if (!(s.transport === 'direct' && s.directUrl && !motionWhileBusy)) {
			this.noteLine(verb, 'queue');
			return this.callRoute(verb, args, init.signal);
		}

		// BIMS half BEFORE the robot: the labware definition to register.
		let robotArgs = args;
		if (DEFINITION_VERBS.has(verb)) {
			const resolved = await this.resolveDefinition(verb, args, init.signal);
			if (resolved instanceof Response) return resolved; // 400/404 exactly as the route would
			robotArgs = { ...args, ...resolved, hardened: s.hardened === true };
		}

		const out = await this.callDirect(verb, robotArgs, s.directUrl, init.signal);
		this.noteLine(verb, out.line === 'direct' ? 'tailscale' : 'queue');
		if (out.line === 'queue') return out.res; // fell back: the route wrote its own records

		// BIMS half AFTER the robot: audit row / tip cursor, same writer as the route.
		const rec = maintenanceRecordFor(verb, robotArgs, out.result);
		if (!rec) return jsonResponse(out.result.status, out.result.body);
		let extra: Record<string, unknown> = {};
		try {
			const res = await this.fetchImpl(`${API(this.robotId)}/direct-record`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ record: rec })
			});
			if (!res.ok) throw new Error(`BIMS answered ${res.status}`);
			extra = await res.json();
		} catch (e) {
			// The robot already acted; never report that as a failure. Say what's missing.
			const msg = e instanceof Error ? e.message : String(e);
			console.warn(`[robot-session] ${rec.event} not recorded in BIMS:`, msg);
			extra = { recordError: `robot OK, but BIMS did not record ${rec.event}: ${msg}` };
		}
		return jsonResponse(out.result.status, { ...(out.result.body as object), ...extra });
	}

	/** Same lookup the load-labware / pick-up-tip routes do, via GET /labware/resolve. */
	private async resolveDefinition(
		verb: Ot2Verb,
		args: Record<string, unknown>,
		signal?: AbortSignal
	): Promise<Response | Record<string, unknown>> {
		const loadName = verb === 'mx.pickUpTip' ? args.tiprackLoadName : args.loadName;
		if (verb === 'mx.pickUpTip' && (!args.pipetteId || typeof args.pipetteId !== 'string')) {
			return jsonResponse(400, { message: 'pipetteId required' });
		}
		if (!loadName || typeof loadName !== 'string') {
			return jsonResponse(400, { message: verb === 'mx.pickUpTip' ? 'tiprackLoadName required' : 'loadName required' });
		}
		const q = new URLSearchParams({ loadName });
		if (verb === 'mx.loadLabware') {
			if (typeof args.namespace === 'string' && args.namespace) q.set('namespace', args.namespace);
			if (args.version != null) q.set('version', String(args.version));
		}
		const res = await this.fetchImpl(`/api/opentrons-lab/labware/resolve?${q}`, { signal });
		if (!res.ok) return res;
		return (await res.json()) as Record<string, unknown>;
	}

	/**
	 * Drop-in for fetch() on pages that already call the BIMS routes: this robot's
	 * maintenance routes (open, close, load labware, pick up tip, jog, move,
	 * position, home, drop tip) run on the session's line; any other request is a
	 * plain fetch to BIMS.
	 */
	fetchRoute(path: string, init: RequestInit = {}): Promise<Response> {
		const hit = routeToVerb(path, init.method ?? 'GET');
		if (!hit || hit.robotId !== this.robotId) return this.fetchImpl(path, init);
		let body: Record<string, unknown> = {};
		try {
			body = init.body ? JSON.parse(String(init.body)) : {};
		} catch {
			/* the route would reject it too; runVerb validates */
		}
		return this.call(hit.verb, { ...body, ...(hit.runId ? { runId: hit.runId } : {}) }, { signal: init.signal ?? undefined });
	}

	/** The queue line: the existing BIMS API route, unchanged. */
	private callRoute(verb: Ot2Verb, args: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
		const { method, path } = verbRoute(verb, args);
		const body = Object.fromEntries(Object.entries(args).filter(([k]) => !LINE_ONLY_ARGS.includes(k)));
		return this.fetchImpl(`${API(this.robotId)}${path}`, {
			method,
			...(method === 'POST'
				? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
				: {}),
			signal
		});
	}

	private async callDirect(
		verb: Ot2Verb,
		args: Record<string, unknown>,
		directUrl: string,
		signal?: AbortSignal
	): Promise<{ line: 'direct'; result: { status: number; body: unknown } } | { line: 'queue'; res: Response }> {
		let lineError: string | null = null;
		const base = browserTransport(directUrl, (input, init) =>
			this.fetchImpl(input, { ...init, signal: withCallerSignal(init?.signal as AbortSignal, signal) })
		);
		// Wrap the transport so each robot request is traced and a no-answer is
		// told apart from a robot answering with an error.
		const track =
			(method: 'GET' | 'POST' | 'DELETE', send: () => Promise<Response>, path: string) =>
			async (): Promise<Response> => {
				const t0 = Date.now();
				const at = new Date().toISOString();
				try {
					const res = await send();
					const latencyMs = Date.now() - t0;
					this.record({ verb, method, path, status: res.status, ok: res.ok, latencyMs, at });
					if (res.ok) this.set({ latencyMs });
					return res;
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					this.record({ verb, method, path, status: 0, ok: false, latencyMs: Date.now() - t0, error: msg, at });
					// The caller's own timeout/abort is not a line failure — surface it as-is.
					if (!signal?.aborted) lineError = msg;
					throw e;
				}
			};
		const tracked: Ot2Transport = {
			get: (path, o) => track('GET', () => base.get(path, o), path)(),
			post: (path, body, o) => track('POST', () => base.post(path, body, o), path)(),
			delete: (path, o) => track('DELETE', () => base.delete(path, o), path)()
		};

		const r = await runVerb(tracked, verb, args);

		if (signal?.aborted) {
			// Keep the caller's error semantics (e.g. EmbeddedRunController's TimeoutError).
			throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
		}
		if (lineError) {
			this.fallBack(`direct link failed: ${lineError}`);
			// A NO_RETRY verb (relative jog, tip pick-up, run creation, …) may have
			// landed even though the answer was lost — repeating it would act twice.
			// Everything else is safe to repeat (reads, open/close, absolute moves,
			// home, play/pause/stop).
			if (NO_RETRY_VERBS.has(verb)) {
				return { line: 'queue', res: jsonResponse(502, { message: noRetryMessage(verb) }) };
			}
			return { line: 'queue', res: await this.callRoute(verb, args, signal) };
		}
		return { line: 'direct', result: r };
	}

	/**
	 * Raw, tracked robot request (OT2-TAILNET-5) — what the isomorphic
	 * robot-client (openapi-fetch) runs over in the browser. `path` is on the
	 * robot origin: '/health', '/runs?pageLength=10', later '/bridge/…'.
	 *
	 *   direct line  directUrl + path, with 'opentrons-version: 3' unless the
	 *                caller set one (and Content-Type: application/json for a
	 *                string body without one; never for FormData / binary).
	 *                Logged to /direct-calls as 'raw:METHOD /template'.
	 *   queue line   POST /api/opentrons-lab/robots/:id/relay {method, path, body}
	 *                — one queue command, answered with the robot's status + JSON.
	 *
	 * A direct request with no answer switches the page to the queue (sticky,
	 * like call()). A GET is then retried through the relay; a mutating request
	 * is NOT (it may have happened) and answers 502. Binary / multipart bodies
	 * and non-JSON answers (Accept: text/…, octet-stream) can't ride the relay:
	 * on the queue line they answer 409 "needs Tailscale".
	 * While a daemon job holds the gantry, mutating raw calls go through the
	 * relay so the queue serialises them with the job (the busy guard).
	 */
	async robotFetch(path: string, init: RobotFetchInit = {}): Promise<Response> {
		if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
			return jsonResponse(400, { message: `robotFetch path must start with "/" (got ${JSON.stringify(path)})` });
		}
		const { timeoutMs, ...rest } = init;
		const method = (rest.method ?? 'GET').toUpperCase();
		const mutating = method !== 'GET' && method !== 'HEAD';
		const headers = new Headers(rest.headers ?? undefined);
		const binary = isBinaryBody(rest.body) || wantsBinaryAnswer(headers);
		const verb = rawVerbLabel(method, path);
		const s = this._state;
		const busyMutation = mutating && !!s.busy && !binary;

		if (s.transport === 'direct' && s.directUrl && !busyMutation) {
			if (!headers.has('opentrons-version')) headers.set('opentrons-version', '3');
			if (typeof rest.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
			const caller = rest.signal ?? undefined;
			const t0 = Date.now();
			const at = new Date().toISOString();
			try {
				const res = await this.fetchImpl(`${s.directUrl}${path}`, {
					...rest,
					method,
					headers,
					signal: withCallerSignal(AbortSignal.timeout(timeoutMs ?? RAW_DEFAULT_TIMEOUT_MS), caller)
				});
				const latencyMs = Date.now() - t0;
				this.record({ verb, method, path, status: res.status, ok: res.ok, latencyMs, at });
				if (res.ok) this.set({ latencyMs });
				this.noteLine(verb, 'tailscale');
				return res;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				this.record({ verb, method, path, status: 0, ok: false, latencyMs: Date.now() - t0, error: msg, at });
				// The caller's own timeout/abort is not a line failure — surface it as-is.
				if (caller?.aborted) throw caller.reason ?? e;
				this.fallBack(`direct link failed: ${msg}`);
				if (mutating) {
					this.noteLine(verb, 'queue');
					return jsonResponse(502, { message: noRetryMessage(verb) });
				}
				// A read is safe to repeat: fall through to the relay.
			}
		}

		this.noteLine(verb, 'queue');
		if (binary) {
			return jsonResponse(409, {
				message: `needs Tailscale — ${method} ${rawPathTemplate(path)} carries a file, which the BIMS queue can't relay. Use a computer on the tailnet (${this._state.reason}).`,
				needsTailscale: true
			});
		}
		let body: unknown = undefined;
		if (typeof rest.body === 'string' && rest.body.length) {
			try {
				body = JSON.parse(rest.body);
			} catch {
				return jsonResponse(400, { message: 'the BIMS queue relays JSON bodies only' });
			}
		}
		return this.fetchImpl(`${API(this.robotId)}/relay`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ method, path, ...(body !== undefined ? { body } : {}) }),
			signal: rest.signal ?? undefined
		});
	}

	/** Remember which line a verb ran on (pill tooltip). Only notifies on a new entry. */
	private noteLine(verb: string, line: 'tailscale' | 'queue') {
		const cur = this._state.usedVia ?? { tailscale: [], queue: [] };
		if (cur[line].includes(verb)) return;
		const next = { ...cur, [line]: [...cur[line], verb].slice(-USED_VIA_MAX) };
		this.set({ usedVia: next });
	}

	private record(row: Omit<DirectCallRow, 'sessionId'>) {
		this.log.push({ sessionId: this.sessionId, ...row });
		if (this.log.length >= 50) void this.flush();
	}

	/** Send the buffered direct-call trace to BIMS. Fire-and-forget. */
	async flush(keepalive = false): Promise<void> {
		if (!this.log.length) return;
		const calls = this.log.splice(0, 50);
		try {
			await this.fetchImpl(`${API(this.robotId)}/direct-calls`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ calls }),
				keepalive
			});
		} catch {
			/* observability only — never block robot control on it */
		}
		if (this.log.length) void this.flush(keepalive);
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimer) clearInterval(this.refreshTimer);
		if (this.flushTimer) clearInterval(this.flushTimer);
		if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
		void this.flush(true);
		this.listeners.clear();
	}
}

/** Open (and decide the line for) a session. Never throws; worst case is 'queue'. */
export async function openRobotSession(robotId: string, options?: SessionOptions): Promise<RobotSession> {
	const s = new RobotSession(robotId, options);
	await s.open();
	return s;
}
