/**
 * PERM-03: deny-by-default route policy + shadow-mode evaluator (docs/prds/PERM-03).
 *
 * The evaluator computes what the NEW permission model (PERM-00) would decide
 * for a request. In shadow mode (PERMISSIONS_ENFORCE unset/false) verdicts are
 * only logged — nothing is ever blocked. PERM-04 flips enforcement after ≥7
 * clean shadow days.
 *
 * Classification is by credential, not path: requests presenting API-key
 * material (agent / station / MCP / cron callers) are exempt here — the
 * machine surface keeps its own key checks and is scope-limited in PERM-05.
 *
 * Self-contained on purpose: the shadow-log model is registered here rather
 * than in models/index.ts.
 */
import mongoose from 'mongoose';
import { error, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB } from '$lib/server/db/connection';
import { hasPermission } from '$lib/server/permissions';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Paths reachable with no session at all. */
const PUBLIC_PREFIXES = ['/login', '/logout', '/invite'];

/**
 * Admin-gated ROUTE prefixes (longest match wins). Most gates guard actions,
 * not routes — those keep in-file requirePermission calls (PERM-04 §B); this
 * map only covers whole areas.
 */
const ADMIN_GATE_PREFIXES: [string, string][] = [
	['/admin', 'admin:full']
];

/** Gate patterns that live inside otherwise-open areas. */
function matchActionGate(path: string): string | null {
	if (/^\/documents\/[^/]+\/approve/.test(path)) return 'document:approve';
	return null;
}

export type PolicyVerdict =
	| { allow: true }
	| { allow: false; reason: 'unauthenticated' | 'no-bims-membership' | `gate:${string}` };

type MinimalUser = { username?: string; roles?: { roleId: string; roleName: string; permissions: string[] }[] } | null;

/** What the new model would decide for a session-authenticated (or anonymous) request. */
export function evaluateRoutePolicy(user: MinimalUser, path: string): PolicyVerdict {
	if (PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) return { allow: true };
	if (!user) return { allow: false, reason: 'unauthenticated' };
	if (!hasPermission(user, 'bims')) return { allow: false, reason: 'no-bims-membership' };

	const prefixGate = ADMIN_GATE_PREFIXES.find(([p]) => path === p || path.startsWith(p + '/'))?.[1];
	const gate = matchActionGate(path) ?? prefixGate;
	if (gate && !hasPermission(user, gate)) return { allow: false, reason: `gate:${gate}` };

	return { allow: true };
}

/** True when the request authenticates by key material rather than session. */
export function hasApiKeyMaterial(request: Request, url: URL): boolean {
	return Boolean(
		request.headers.get('x-api-key') ||
		request.headers.get('x-agent-api-key') ||
		request.headers.get('x-station-agent-key') ||
		request.headers.get('authorization') ||
		url.searchParams.has('key') ||
		url.pathname.startsWith('/api/mcp/k/')
	);
}

// ---------------------------------------------------------------------------
// Shadow log (TTL 30 days)
// ---------------------------------------------------------------------------

const shadowSchema = new mongoose.Schema(
	{
		_id: { type: String },
		createdAt: { type: Date, default: () => new Date(), expires: 60 * 60 * 24 * 30 },
		path: String,
		method: String,
		username: { type: String, default: null },
		reason: String
	},
	{ collection: 'permission_shadow_log', versionKey: false }
);
shadowSchema.index({ reason: 1, username: 1 });

const PermissionShadowLog =
	(mongoose.models.PermissionShadowLog as mongoose.Model<any>) ??
	mongoose.model('PermissionShadowLog', shadowSchema);

/**
 * Apply the new model to a request. Two modes, selected by PERMISSIONS_ENFORCE:
 *
 * - Shadow (default, PERM-03): would-be denials are logged and NOTHING is
 *   blocked. The logging path can never throw — total failure of it must not
 *   affect the request.
 * - Enforce ('true', flipped in PERM-04 after ≥7 clean shadow days): denials
 *   become real — redirect to /login (pages) / 401 (API) when unauthenticated,
 *   403 otherwise. Set PERMISSIONS_ENFORCE=false in Vercel to roll back
 *   instantly without a deploy.
 */
export async function applyRoutePolicy(opts: {
	user: MinimalUser;
	request: Request;
	url: URL;
}): Promise<void> {
	const { user, request, url } = opts;
	const method = request.method;
	if (method === 'OPTIONS' || method === 'HEAD') return;
	if (hasApiKeyMaterial(request, url)) return; // machine surface — PERM-05

	const verdict = evaluateRoutePolicy(user, url.pathname);
	if (verdict.allow) return;

	if (env.PERMISSIONS_ENFORCE === 'true') {
		if (verdict.reason === 'unauthenticated') {
			if (url.pathname.startsWith('/api/')) throw error(401, 'Unauthorized');
			throw redirect(302, '/login');
		}
		throw error(403, `Permission denied: ${verdict.reason}`);
	}

	// Shadow mode — log only, swallow every failure.
	try {
		// Anonymous requests to non-public pages are already redirected by the
		// current hooks — only log them for /api/ paths, where today they reach
		// the endpoint's own (possibly missing) check.
		if (verdict.reason === 'unauthenticated' && !url.pathname.startsWith('/api/')) return;

		await connectDB();
		await PermissionShadowLog.create({
			_id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			path: url.pathname,
			method,
			username: user?.username ?? null,
			reason: verdict.reason
		});
	} catch (e) {
		console.error('[PERM-SHADOW] logging error (ignored):', e instanceof Error ? e.message : e);
	}
}
