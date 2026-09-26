/**
 * Typed client for the Opentrons OT-2 HTTP API — isomorphic (OT2-TAILNET-5 S10a).
 *
 * openapi-fetch + the `opentrons-version` header, with the fetch INJECTED:
 *
 *   browser  sessionRobotClient(session) — every request is
 *            session.robotFetch(path, init): the robot's tailnet origin on the
 *            direct line (logged to /direct-calls), the BIMS relay
 *            (/api/opentrons-lab/robots/:id/relay → one queue command) otherwise.
 *   server   createRobotClient({ baseUrl: 'http://<ip>:31950' }) — plain fetch;
 *            $lib/server/opentrons/client.ts wraps this for scripts.
 *
 * Every call is a live pass-through to the robot. No DB, no caching, no BIMS
 * records — anything BIMS must record goes through the shared verbs
 * ($lib/opentrons/ot2-protocol) or a server route, never through here.
 */
import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from './openapi-types';
import { sendMaintenanceCommand, type Ot2Transport } from './ot2-protocol';

export type OpentronsClient = ReturnType<typeof createClient<paths>>;
export type { components, paths } from './openapi-types';

export const OPENTRONS_VERSION_HEADER = 'opentrons-version';
/**
 * Per-request transport timeout, carried as a header so a typed call can ask
 * for more than the default (e.g. a 60 s home). Stripped before the robot.
 */
export const TIMEOUT_HEADER = 'x-ot2-timeout-ms';
/** Origin for path-based clients (the session): stripped by the adapter. */
export const SESSION_ORIGIN = 'http://ot2-session.invalid';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface RobotClientOptions {
	/** openapi-fetch's fetch: gets a Request. Defaults to globalThis.fetch. */
	fetch?: (input: Request) => Promise<Response>;
	/** Robot origin, e.g. http://10.0.0.5:31950. Defaults to SESSION_ORIGIN. */
	baseUrl?: string;
	/**
	 * Client-side abort (server use). null = none — the injected fetch owns the
	 * timeout (the session's robotFetch does, and reads TIMEOUT_HEADER itself).
	 */
	timeoutMs?: number | null;
	/**
	 * opentrons-version value set when the caller didn't set one. Default '*'
	 * (today's server client). null = leave it to the injected fetch (the
	 * session sets '3', the same value the queue relay / proxy.ts send).
	 */
	versionHeader?: string | null;
}

export function createRobotClient(options: RobotClientOptions = {}): OpentronsClient {
	const versionHeader = options.versionHeader === undefined ? '*' : options.versionHeader;
	const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;

	const middleware: Middleware = {
		async onRequest({ request }) {
			if (versionHeader && !request.headers.has(OPENTRONS_VERSION_HEADER)) {
				request.headers.set(OPENTRONS_VERSION_HEADER, versionHeader);
			}
			if (timeoutMs === null) return request; // the injected fetch reads TIMEOUT_HEADER
			const asked = Number(request.headers.get(TIMEOUT_HEADER));
			request.headers.delete(TIMEOUT_HEADER);
			const ms = Number.isFinite(asked) && asked > 0 ? asked : timeoutMs;
			return new Request(request, { signal: AbortSignal.timeout(ms) });
		}
	};

	const client = createClient<paths>({
		baseUrl: (options.baseUrl ?? SESSION_ORIGIN).replace(/\/+$/, ''),
		...(options.fetch ? { fetch: options.fetch } : {})
	});
	client.use(middleware);
	return client;
}

/** The raw, tracked robot request a RobotSession exposes. */
export type RawRobotFetch = (path: string, init?: RequestInit & { timeoutMs?: number }) => Promise<Response>;

/**
 * openapi-fetch hands its fetch a Request on SESSION_ORIGIN; turn it into a
 * path-based robotFetch call. JSON/text bodies stay strings (so the relay can
 * carry them); anything else (multipart) goes as bytes — which the session
 * sends direct and refuses on the queue line ("needs Tailscale").
 */
export function robotFetchAdapter(raw: RawRobotFetch): (req: Request) => Promise<Response> {
	return async (req: Request) => {
		const u = new URL(req.url);
		const path = `${u.pathname}${u.search}`;
		const headers = new Headers(req.headers);
		const asked = Number(headers.get(TIMEOUT_HEADER));
		headers.delete(TIMEOUT_HEADER);
		let body: string | ArrayBuffer | undefined;
		if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
			const ct = headers.get('content-type') ?? '';
			if (!ct || /json|^text\//i.test(ct)) {
				const text = await req.text();
				body = text.length ? text : undefined;
			} else {
				body = await req.arrayBuffer();
			}
		}
		return raw(path, {
			method: req.method,
			headers,
			...(body !== undefined ? { body } : {}),
			...(Number.isFinite(asked) && asked > 0 ? { timeoutMs: asked } : {})
		});
	};
}

/** The browser client: typed calls over the page's robot session. */
export function sessionRobotClient(session: { robotFetch: RawRobotFetch }): OpentronsClient {
	return createRobotClient({
		fetch: robotFetchAdapter((path, init) => session.robotFetch(path, init)),
		baseUrl: SESSION_ORIGIN,
		timeoutMs: null,
		versionHeader: null
	});
}

/**
 * Unwrap an openapi-fetch result, throwing on error.
 * Keep the signature loose — openapi-fetch's response shape carries rich generics
 * that aren't worth threading through every caller.
 */
export function unwrap<T>(res: { data?: T; error?: unknown; response: Response }): T {
	if (res.error !== undefined) {
		throw new Error(
			`Opentrons API error: ${res.response.status} ${res.response.statusText} — ${JSON.stringify(res.error)}`
		);
	}
	return res.data as T;
}

/** GET a path; null on any error (robot answer or no answer). */
export async function safeGet<T = any>(client: OpentronsClient, path: string, query?: Record<string, unknown>): Promise<T | null> {
	try {
		const res = await (client as any).GET(path, query ? { params: { query } } : {});
		if (res.error !== undefined) return null;
		return res.data as T;
	} catch {
		return null;
	}
}

// ── mx.command: LPC's arbitrary maintenance commands (moved from maintenance-clone.ts) ──

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Typed union of the command-create payloads LPC needs. Each element matches
 * its `*Create` schema in the live OpenAPI and is accepted by
 * `POST /maintenance_runs/{runId}/commands`.
 */
export type MaintenanceCommand =
	| components['schemas']['HomeCreate']
	| components['schemas']['LoadPipetteCreate']
	| components['schemas']['LoadLabwareCreate']
	| components['schemas']['PickUpTipCreate']
	| components['schemas']['MoveToWellCreate']
	| components['schemas']['MoveRelativeCreate']
	| components['schemas']['SavePositionCreate']
	| components['schemas']['DropTipCreate'];

export const ALLOWED_COMMAND_TYPES = [
	'home',
	'loadPipette',
	'loadLabware',
	'pickUpTip',
	'moveToWell',
	'moveRelative',
	'savePosition',
	'dropTip'
] as const;
export type AllowedCommandType = (typeof ALLOWED_COMMAND_TYPES)[number];

export function isAllowedCommandType(s: unknown): s is AllowedCommandType {
	return typeof s === 'string' && (ALLOWED_COMMAND_TYPES as readonly string[]).includes(s);
}

/**
 * Minimal shape of an executed command. Every variant has `id`, `commandType`,
 * `status`, and optional `result`/`error`, which is everything callers need.
 */
export interface MaintenanceCommandResult {
	id: string;
	commandType: string;
	status: string;
	result?: Record<string, unknown> | null;
	error?: Record<string, unknown> | null;
	[k: string]: unknown;
}

/**
 * An Ot2Transport over a raw robotFetch (the session's, or any fetch-shaped
 * function on the robot origin) — so the shared ot2-protocol helpers run over
 * the page's robot session: direct over Tailscale, the BIMS relay otherwise.
 * Headers match browserTransport / proxy.ts (opentrons-version 3, JSON body).
 */
export function robotFetchTransport(raw: RawRobotFetch): Ot2Transport {
	return {
		get: (path, opts) => raw(path, { timeoutMs: opts?.timeoutMs }),
		post: (path, body, opts) =>
			raw(path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				timeoutMs: opts?.timeoutMs
			}),
		delete: (path, opts) => raw(path, { method: 'DELETE', timeoutMs: opts?.timeoutMs })
	};
}

/**
 * Enqueue one command on a maintenance run and wait for it (the S10a
 * `mx.command` capability, used by LPC). The robot request itself is the ONE
 * shared implementation — ot2-protocol's sendMaintenanceCommand, the same code
 * the queue routes and the `mx.command` verb run — here over the session's
 * robotFetch. This adds only LPC's commandType allow-list and the result shape.
 *
 * Throws on a disallowed commandType, a robot error, no answer, or a command
 * that resolved to `status: failed`. Never retried: over the session a lost
 * answer on a mutating request comes back as a 502 ("NOT retried").
 */
export async function maintenanceCommand(
	robotFetch: RawRobotFetch,
	runId: string,
	command: MaintenanceCommand | { commandType: string; params?: Record<string, unknown> },
	options: { timeoutMs?: number } = {}
): Promise<MaintenanceCommandResult> {
	if (!isAllowedCommandType(command?.commandType)) {
		throw new Error(`commandType must be one of: ${ALLOWED_COMMAND_TYPES.join(', ')}`);
	}
	const params = ((command as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown>;
	const body = await sendMaintenanceCommand(robotFetchTransport(robotFetch), runId, command.commandType, params, {
		waitUntilComplete: true,
		timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
	});
	const result = (body as { data?: MaintenanceCommandResult } | undefined)?.data;
	if (!result) throw new Error(`${command.commandType}: robot answered without a command`);
	return result;
}

// ── read helpers for pages that used to call the robot from their server load ──

/** Latest analysis (full) of a protocol, or null. Same walk every page did. */
export async function latestAnalysis(client: OpentronsClient, protocolId: string): Promise<{ analyses: any[]; latest: any | null }> {
	const res = await (client as any).GET('/protocols/{protocolId}/analyses', { params: { path: { protocolId } } });
	if (res.error !== undefined) return { analyses: [], latest: null };
	const analyses = (res.data?.data ?? []) as any[];
	const last = analyses[analyses.length - 1];
	if (!last?.id) return { analyses, latest: null };
	const d = await (client as any).GET('/protocols/{protocolId}/analyses/{analysisId}', {
		params: { path: { protocolId, analysisId: last.id } }
	});
	return { analyses, latest: d.error === undefined ? (d.data?.data ?? null) : null };
}

/**
 * Download a robot file (log, data file, analysis document) as a blob URL.
 * Tailnet only: over the queue it answers 409 "needs Tailscale" — the BIMS
 * relay carries JSON, not files. Throws with the robot's / session's message.
 */
export async function downloadRobotFile(
	robotFetch: RawRobotFetch,
	path: string,
	filename: string,
	accept = 'application/octet-stream'
): Promise<void> {
	const res = await robotFetch(path, { headers: { Accept: accept }, timeoutMs: 60_000 });
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(body?.message ?? body?.errors?.[0]?.detail ?? `Download failed (${res.status})`);
	}
	const blob = await res.blob();
	const disposition = res.headers.get('content-disposition') ?? '';
	const named = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
	const url = URL.createObjectURL(blob);
	try {
		const a = document.createElement('a');
		a.href = url;
		a.download = named ?? filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
	} finally {
		setTimeout(() => URL.revokeObjectURL(url), 30_000);
	}
}

// ── S7: the legacy /opentrons pages' live reads (were server loads on the LAN IP) ──

/**
 * /opentrons/devices/[robotId]: health, pipettes, recent runs — exactly the
 * shape that page's server load returned. robotOffline when /health fails.
 */
export async function readDeviceLive(client: OpentronsClient, fallbackName = ''): Promise<{
	robotOffline: boolean;
	info: { health: Record<string, unknown>; pipettes: any[]; modules: any[] } | null;
	recentRuns: any[] | null;
}> {
	const health = await safeGet<any>(client, '/health');
	if (!health) return { robotOffline: true, info: null, recentRuns: null };
	const info = {
		health: {
			name: health.name ?? fallbackName,
			api_version: health.api_version ?? null,
			fw_version: health.fw_version ?? null,
			system_version: health.system_version ?? null,
			robot_serial: health.robot_serial ?? null,
			robot_model: health.robot_model ?? null
		},
		pipettes: [] as any[],
		modules: [] as any[]
	};
	const [pip, runs] = await Promise.all([safeGet<any>(client, '/pipettes'), safeGet<any>(client, '/runs', { pageLength: 10 })]);
	if (pip) info.pipettes = Object.entries(pip).map(([mount, d]: [string, any]) => ({ mount, ...d }));
	const recentRuns = runs
		? (runs.data ?? []).map((r: any) => ({
				id: r.id,
				status: r.status ?? 'unknown',
				protocolId: r.protocolId ?? null,
				createdAt: r.createdAt ?? null,
				completedAt: r.completedAt ?? null
			}))
		: null;
	return { robotOffline: false, info, recentRuns };
}

/** A robot protocol + its latest analysis (via analysisSummaries), as the legacy loads did. */
export async function readProtocolLive(
	client: OpentronsClient,
	protocolId: string
): Promise<{ robotOffline: boolean; protocol: any | null; analysis: any | null }> {
	const res = await safeGet<any>(client, `/protocols/${encodeURIComponent(protocolId)}`);
	if (!res) return { robotOffline: true, protocol: null, analysis: null };
	const protocol = res.data ?? res;
	let analysis: any = null;
	const summaries = protocol?.analysisSummaries ?? [];
	if (summaries.length > 0) {
		const latestId = summaries[summaries.length - 1].id;
		const a = await safeGet<any>(client, `/protocols/${encodeURIComponent(protocolId)}/analyses/${encodeURIComponent(latestId)}`);
		analysis = a?.data ?? null;
	}
	return { robotOffline: false, protocol, analysis };
}

/** A robot run, or null when the robot didn't answer. */
export async function readRunLive(client: OpentronsClient, runId: string): Promise<any | null> {
	const res = await safeGet<any>(client, `/runs/${encodeURIComponent(runId)}`);
	return res ? (res.data ?? res) : null;
}
