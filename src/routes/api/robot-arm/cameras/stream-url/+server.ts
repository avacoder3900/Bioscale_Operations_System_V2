/**
 * ARM-02 mode B — hand the browser what it needs to stream directly from the Pi.
 *
 * The sibling snapshot route proxies every frame through BIMS so that a phone
 * on cellular, with no Tailscale client, still sees the arm. That reach is the
 * baseline and it does not change. But it costs a round trip per frame through
 * a serverless function, which is why the feed looks like stills rather than
 * video.
 *
 * For a viewer that *can* reach the Pi's public origin, one <img> pointed at
 * the MJPEG endpoint is dramatically better: the connection opens once and
 * frames arrive as fast as the camera produces them. This route mints the
 * credential that makes that possible.
 *
 * Two deliberate constraints, because this is the one place ARM-01 G0's "the
 * browser never learns the Pi's address" is relaxed:
 *
 *  1. It publishes ROBOT_ARM_PUBLIC_URL, never ROBOT_ARM_BASE_URL. They are
 *     separate variables on purpose. The private one may be a LAN or
 *     tailnet-only address and stays server-side exactly as before; only an
 *     origin an operator has explicitly designated as public is ever sent out.
 *     When it is unset, the only other origin ever published is the Pi's
 *     Cloudflare quick-tunnel URL (robot_arm_endpoints 'tunnel', which the
 *     Pi registers itself and which is already a public origin by
 *     construction; approved 2026-10-20 so the live feed reaches 30 fps).
 *     It must match *.trycloudflare.com. No usable origin means mode B is
 *     unavailable, and the panel keeps polling snapshots.
 *
 *     Third (approved by the operator 2026-10-20, to match the CV stations):
 *     ROBOT_ARM_BASE_URL is ALSO listed in `origins`, but only when it is an
 *     https://<machine>.<tailnet>.ts.net origin. That name is the Pi's own
 *     Tailscale/Funnel hostname, already public in DNS; a viewer on the
 *     tailnet reaches it peer-to-peer (~0.1 s/frame vs ~0.6 s through the
 *     Cloudflare tunnel, measured). A LAN/tailnet IP or any other value is
 *     never published. The browser probes every origin and keeps the fastest.
 *
 *  2. It never sends ROBOT_ARM_API_KEY. What ships is a camera-scoped token
 *     that cannot move the arm and expires in minutes.
 *
 * Failures here are soft, not 5xx: a caller that cannot get a stream token has
 * a working fallback, so degrading quietly to snapshot polling is the correct
 * outcome and an error page is not.
 */
import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requirePermission } from '$lib/server/permissions';
import { robotArm } from '$lib/server/robot-arm-client';
import { connectDB } from '$lib/server/db/connection';
import { RobotArmEndpoint } from '$lib/server/db/models';
import type { RequestHandler } from './$types';

const TUNNEL_URL_RE = /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/;
// The Pi's Tailscale machine name (Funnel/tailnet). Nothing else from ROBOT_ARM_BASE_URL is ever sent.
const TAILNET_URL_RE = /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*\.ts\.net$/;
// Generous on purpose: the Pi's heartbeat can fail while its tunnel still works
// (office DNS outage, 2026-10-20), and a dead URL only costs the browser one
// failed probe before it settles on the proxy feed.
const TUNNEL_MAX_AGE_MS = 48 * 60 * 60 * 1000;

async function registeredTunnelOrigin(): Promise<string | null> {
	try {
		await connectDB();
		const row = (await RobotArmEndpoint.findById('tunnel').lean()) as {
			url?: string;
			registeredAt?: Date;
		} | null;
		if (!row?.url || !row.registeredAt || !TUNNEL_URL_RE.test(row.url)) return null;
		if (Date.now() - new Date(row.registeredAt).getTime() > TUNNEL_MAX_AGE_MS) return null;
		return row.url;
	} catch {
		return null;
	}
}

function tailnetOrigin(): string | null {
	const raw = env.ROBOT_ARM_BASE_URL?.trim().replace(/\/+$/, '') ?? '';
	return TAILNET_URL_RE.test(raw) ? raw : null;
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const tunnelUrl = await registeredTunnelOrigin();
	const publicUrl = env.ROBOT_ARM_PUBLIC_URL?.trim() || tunnelUrl;
	const tailnetUrl = tailnetOrigin();
	if (!publicUrl && !tailnetUrl) {
		return json({
			available: false,
			reason: 'ROBOT_ARM_PUBLIC_URL is not configured and no tunnel is registered'
		});
	}

	try {
		const body = await robotArm.mintStreamToken();
		const token = body?.stream_token;
		if (!token) {
			// An older Pi build authenticates fine but only sets the cookie, which
			// is useless cross-origin. Treat that as "mode B not supported here".
			return json({ available: false, reason: 'Pi returned no stream token' });
		}

		const origins = [publicUrl, tailnetUrl, tunnelUrl]
			.filter((o): o is string => !!o)
			.map((o) => o.replace(/\/+$/, ''))
			.filter((o, i, all) => all.indexOf(o) === i);
		return json(
			{
				available: true,
				// `origin` is the preferred one (older clients read only this);
				// `origins` is every route the browser may race.
				origin: origins[0],
				origins,
				token,
				expiresInS: body.stream_token_expires_in_s ?? 900
			},
			{
				// This body carries a credential. Nothing may hold a copy: not the
				// browser cache, not a CDN edge, not the back/forward cache.
				headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, private' }
			}
		);
	} catch (err) {
		// Log the reason but never the token, and never the upstream URL — the
		// message can contain the private base URL.
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error('[arm-camera] stream token mint failed:', message);
		return json({ available: false, reason: 'Could not mint a stream token' });
	}
};
