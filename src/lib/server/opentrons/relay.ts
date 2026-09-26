/**
 * Generic robot relay — the queue line for raw robot calls (OT2-TAILNET-5 §7.8.3).
 *
 *   POST /api/opentrons-lab/robots/:id/relay   { method, path, body? }
 *     → the robot's HTTP status, with the robot's JSON body verbatim
 *
 * A browser that can't reach the robot over Tailscale (or fell back) sends each
 * robot-client request here instead. It runs exactly ONE robot request through
 * the existing proxy.ts exports — robotGet / robotPost / robotPatch /
 * robotDelete — which on Vercel become one kind:'http' Ot2BridgeCommand, the
 * same as every other queue call. Nothing here re-implements robot logic.
 *
 *   GET                  manufacturing:read
 *   POST / PATCH / DELETE manufacturing:write, plus an AuditLog row 'robot_relay'
 *   PUT / other          405 — proxy.ts has no robotPut, so those need Tailscale
 *
 * Paths are sanity-checked: must start with '/', no scheme / host ('//x',
 * 'http:'), no '..' segment, no backslash or control characters.
 */
import { json, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { getRobot, robotGet, robotPost, robotPatch, robotDelete } from './proxy';

export const RELAY_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
export type RelayMethod = (typeof RELAY_METHODS)[number];

export type RelayRequest = { method: RelayMethod; path: string; body?: unknown };

const MAX_PATH = 2000;

/** The path, or null when it isn't a plain robot-origin path. */
export function sanitizeRelayPath(p: unknown): string | null {
	if (typeof p !== 'string' || !p.length || p.length > MAX_PATH) return null;
	if (!p.startsWith('/') || p.startsWith('//')) return null;
	if (/[\\\u0000-\u001f\u007f]/.test(p)) return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return null;
	const bare = p.split(/[?#]/)[0];
	let decoded: string;
	try {
		decoded = decodeURIComponent(bare);
	} catch {
		return null;
	}
	if (decoded.split('/').some((seg) => seg === '..' || seg === '.')) return null;
	if (decoded.startsWith('//') || /[\\]/.test(decoded)) return null;
	return p;
}

export function parseRelayRequest(
	payload: unknown
): { ok: true; req: RelayRequest } | { ok: false; status: number; message: string } {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return { ok: false, status: 400, message: 'body must be {method, path, body?}' };
	}
	const p = payload as Record<string, unknown>;
	const method = typeof p.method === 'string' ? p.method.toUpperCase() : 'GET';
	if (!(RELAY_METHODS as readonly string[]).includes(method)) {
		return {
			ok: false,
			status: 405,
			message: `${method} can't be relayed through the BIMS queue (supported: ${RELAY_METHODS.join(', ')}) — use a computer on Tailscale`
		};
	}
	const path = sanitizeRelayPath(p.path);
	if (!path) return { ok: false, status: 400, message: 'path must be a robot path starting with "/" (no host, no "..")' };
	return { ok: true, req: { method: method as RelayMethod, path, ...(p.body !== undefined ? { body: p.body } : {}) } };
}

export const isMutating = (m: RelayMethod) => m !== 'GET';

export function relayPermission(m: RelayMethod): 'manufacturing:read' | 'manufacturing:write' {
	return isMutating(m) ? 'manufacturing:write' : 'manufacturing:read';
}

/** One robot request through proxy.ts. Never throws: no answer is a 502. */
export async function relayToRobot(robot: any, req: RelayRequest): Promise<{ status: number; body: unknown }> {
	let res: Response;
	try {
		switch (req.method) {
			case 'GET':
				res = await robotGet(robot, req.path);
				break;
			case 'POST':
				res = await robotPost(robot, req.path, req.body);
				break;
			case 'PATCH':
				res = await robotPatch(robot, req.path, req.body);
				break;
			case 'DELETE':
				res = await robotDelete(robot, req.path);
				break;
			default:
				return { status: 405, body: { message: `${req.method} can't be relayed` } };
		}
	} catch (e) {
		return { status: 502, body: { message: e instanceof Error ? e.message : String(e), relay: 'no answer from robot' } };
	}
	const text = await res.text().catch(() => '');
	let body: unknown = null;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = { message: text.slice(0, 2000) };
		}
	}
	return { status: res.status, body };
}

/** The whole route, injectable for tests. */
export async function handleRelay(event: {
	params: { id: string };
	locals: { user?: any };
	request: Request;
}): Promise<Response> {
	const { params, locals, request } = event;
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const parsed = parseRelayRequest(await request.json().catch(() => null));
	if (!parsed.ok) return json({ message: parsed.message }, { status: parsed.status });
	const req = parsed.req;
	if (isMutating(req.method)) requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const r = await relayToRobot(robot, req);

	if (isMutating(req.method)) {
		await connectDB();
		await AuditLog.create({
			_id: generateId(),
			tableName: 'opentrons_robots',
			recordId: String(robot._id),
			action: 'robot_relay',
			newData: { method: req.method, path: req.path, status: r.status, line: 'queue' },
			changedAt: new Date(),
			changedBy: locals.user.username
		});
	}

	// status 204/304 can't carry a body
	if (r.status === 204 || r.status === 304) return new Response(null, { status: r.status, headers: { 'x-ot2-line': 'queue' } });
	return json(r.body, { status: r.status < 200 || r.status > 599 ? 502 : r.status, headers: { 'x-ot2-line': 'queue' } });
}
