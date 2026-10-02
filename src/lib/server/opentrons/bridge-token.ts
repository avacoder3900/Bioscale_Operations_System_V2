/**
 * /bridge job tokens (OT2-TAILNET-5 §7.3, S5).
 *
 * The on-robot daemon (scripts/ot2-bridge.py) runs a job server behind
 * `tailscale serve --set-path=/bridge`. It can restart robot-server and write
 * files, so every /bridge request carries a short-lived token BIMS mints for a
 * signed-in operator (GET /api/opentrons-lab/robots/[id]/bridge-token). The
 * daemon verifies it with Python's stdlib hmac — no JWT library on the robot.
 *
 * WIRE FORMAT — must match verify_bridge_token / sign_bridge_token in
 * scripts/ot2-bridge.py byte for byte. A compact JWS (JWT), HS256:
 *
 *   token   = B64U(header) "." B64U(claims) "." B64U(HMAC_SHA256(secret, B64U(header) "." B64U(claims)))
 *   header  = {"alg":"HS256","typ":"JWT"}              (exactly these bytes)
 *   claims  = {"aud":"ot2-bridge","robotId":…,"deviceId":…,"kinds":[…],"sub":…,"iat":…,"exp":…,"jti":…}
 *             (compact JSON, this key order; iat/exp are unix SECONDS)
 *   B64U    = base64url without "=" padding
 *   secret  = the UTF-8 bytes of OT2_BRIDGE_TOKEN_SECRET (= the robot's
 *             /data/ot2-bridge/.env BRIDGE_TOKEN_SECRET)
 *
 * The daemon checks: the signature (constant time), alg == HS256,
 * aud == "ot2-bridge", exp (+30 s clock leeway), deviceId == its
 * BRIDGE_DEVICE_ID (and robotId == BRIDGE_ROBOT_ID when set), and that the
 * requested job kind is in kinds. 401 = missing/bad/expired; 403 = wrong
 * robot/kind. A token with kinds [] is good for GET /bridge/health only.
 *
 * The shared test vector (same literal in bridge-token.test.ts and
 * scripts/test_ot2_bridge_server.py) pins the format on both sides.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BRIDGE_TOKEN_KINDS, type BridgeTokenKind } from '$lib/opentrons/bridge-client';
import { resolveRobotConnection } from './connection';

/**
 * The OPT-IN tailnet prepare flag on the daemon-job routes (S6): JSON body
 * `line: 'tailnet'` or query `?line=tailnet`. Absent = today's queue behaviour,
 * byte-identical.
 */
export function isTailnetLineRequest(body: unknown, url?: URL | null): boolean {
	const fromBody = (body as { line?: unknown } | null | undefined)?.line;
	return fromBody === 'tailnet' || url?.searchParams.get('line') === 'tailnet';
}

/**
 * The two-key gate (connection.ts) for daemon jobs: the robot record says
 * 'tailnet' AND this deployment's OT2_TAILNET_ROBOT_IDS allows it. A route that
 * would otherwise prepare a job nobody can submit answers 409 with the reason.
 */
export function tailnetLineGate(
	robot: Parameters<typeof resolveRobotConnection>[0]
): { ok: true; directUrl: string } | { ok: false; reason: string } {
	const c = resolveRobotConnection(robot);
	return c.transport === 'tailnet' ? { ok: true, directUrl: c.directUrl } : { ok: false, reason: c.reason };
}

/**
 * The gate for the daemon-job PREPARE halves (S6): the two-key tailnet gate
 * AND a bridge-token secret on this deployment. Without the secret the browser
 * could never get a token to submit the job, so a prepared row (e.g. a
 * SweepRun) would be stranded — the route answers 409 instead and the page
 * stays on the queue line.
 */
export function bridgeJobGate(
	robot: Parameters<typeof resolveRobotConnection>[0]
): { ok: true; directUrl: string } | { ok: false; reason: string } {
	const g = tailnetLineGate(robot);
	if (!g.ok) return g;
	if (!bridgeTokenSecret()) {
		return { ok: false, reason: 'OT2_BRIDGE_TOKEN_SECRET is not set on this deployment — daemon jobs stay on the queue line' };
	}
	return g;
}

export const BRIDGE_TOKEN_TTL_S = 300;
export const BRIDGE_TOKEN_AUDIENCE = 'ot2-bridge';
/** Same leeway the daemon allows (TOKEN_LEEWAY_S). */
export const BRIDGE_TOKEN_LEEWAY_S = 30;

const HEADER_JSON = '{"alg":"HS256","typ":"JWT"}';

export interface BridgeTokenClaims {
	aud: typeof BRIDGE_TOKEN_AUDIENCE;
	robotId: string;
	deviceId: string;
	kinds: string[];
	sub: string;
	iat: number;
	exp: number;
	jti: string;
}

export function b64url(buf: Buffer | string): string {
	return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(seg: string): Buffer {
	if (!/^[A-Za-z0-9_-]*$/.test(seg)) throw new Error('not base64url');
	return Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function hmac(secret: string, input: string): Buffer {
	return createHmac('sha256', Buffer.from(secret, 'utf8')).update(Buffer.from(input, 'ascii')).digest();
}

/** Sign claims exactly as given (key order preserved by JSON.stringify). */
export function signBridgeToken(claims: BridgeTokenClaims, secret: string): string {
	if (!secret) throw new Error('OT2_BRIDGE_TOKEN_SECRET is not set');
	const signingInput = `${b64url(HEADER_JSON)}.${b64url(Buffer.from(JSON.stringify(claims), 'utf8'))}`;
	return `${signingInput}.${b64url(hmac(secret, signingInput))}`;
}

/** Build claims in the canonical key order and sign them. */
export function mintBridgeToken(
	input: { robotId: string; deviceId: string; kinds: readonly string[]; sub: string },
	secret: string,
	nowS: number = Math.floor(Date.now() / 1000),
	ttlS: number = BRIDGE_TOKEN_TTL_S
): { token: string; exp: number; claims: BridgeTokenClaims } {
	const claims: BridgeTokenClaims = {
		aud: BRIDGE_TOKEN_AUDIENCE,
		robotId: input.robotId,
		deviceId: input.deviceId,
		kinds: [...input.kinds],
		sub: input.sub,
		iat: nowS,
		exp: nowS + ttlS,
		jti: randomBytes(9).toString('base64url')
	};
	return { token: signBridgeToken(claims, secret), exp: claims.exp, claims };
}

export type BridgeTokenCheck =
	| { ok: true; claims: BridgeTokenClaims }
	| { ok: false; status: 401 | 403; error: string };

/**
 * The daemon's verifier, mirrored in TS (tests + any future server-side
 * check). Same order and same 401/403 split as verify_bridge_token.
 */
export function verifyBridgeToken(
	token: string | null | undefined,
	secret: string,
	opts: { deviceId: string; robotId?: string | null; kind?: string | null; nowS?: number }
): BridgeTokenCheck {
	const bad = (error: string): BridgeTokenCheck => ({ ok: false, status: 401, error });
	if (!token) return bad('missing bearer token');
	const parts = token.split('.');
	if (parts.length !== 3) return bad('malformed token');
	const [head, body, sig] = parts;
	let given: Buffer;
	try {
		given = fromB64url(sig);
	} catch {
		return bad('malformed token');
	}
	const expected = hmac(secret, `${head}.${body}`);
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return bad('bad token signature');
	let header: any;
	let claims: any;
	try {
		header = JSON.parse(fromB64url(head).toString('utf8'));
		claims = JSON.parse(fromB64url(body).toString('utf8'));
	} catch {
		return bad('malformed token');
	}
	if (header?.alg !== 'HS256' || !claims || typeof claims !== 'object') return bad('malformed token');
	if (claims.aud !== BRIDGE_TOKEN_AUDIENCE) return bad('token is not a bridge token');
	if (typeof claims.exp !== 'number') return bad('token has no exp');
	const now = opts.nowS ?? Math.floor(Date.now() / 1000);
	if (now > claims.exp + BRIDGE_TOKEN_LEEWAY_S) return bad('token expired');
	if (!Array.isArray(claims.kinds)) return bad('token has no kinds');
	if (claims.deviceId !== opts.deviceId || (opts.robotId && claims.robotId !== opts.robotId)) {
		return { ok: false, status: 403, error: 'token is for another robot' };
	}
	if (opts.kind != null && !claims.kinds.includes(opts.kind)) {
		return { ok: false, status: 403, error: `token does not allow '${opts.kind}'` };
	}
	return { ok: true, claims: claims as BridgeTokenClaims };
}

/** OT2_BRIDGE_TOKEN_SECRET, or null when this deployment has none. */
export function bridgeTokenSecret(): string | null {
	const s = process.env.OT2_BRIDGE_TOKEN_SECRET?.trim();
	return s ? s : null;
}

/**
 * Parse `?kinds=a,b` against the daemon's allowlist. Empty/absent = [] (a
 * health-only token). Returns the unknown kinds so the route can 400.
 */
export function parseBridgeKinds(raw: string | null | undefined): { kinds: BridgeTokenKind[]; unknown: string[] } {
	const wanted = [...new Set((raw ?? '').split(',').map((k) => k.trim()).filter(Boolean))];
	const allowed = new Set<string>(BRIDGE_TOKEN_KINDS);
	return {
		kinds: wanted.filter((k): k is BridgeTokenKind => allowed.has(k)),
		unknown: wanted.filter((k) => !allowed.has(k))
	};
}
