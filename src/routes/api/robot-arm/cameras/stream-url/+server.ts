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
 *     Unset means unset — this route reports mode B unavailable rather than
 *     guessing an origin, and the panel keeps polling snapshots.
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
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const publicUrl = env.ROBOT_ARM_PUBLIC_URL?.trim();
	if (!publicUrl) {
		return json({ available: false, reason: 'ROBOT_ARM_PUBLIC_URL is not configured' });
	}

	try {
		const body = await robotArm.mintStreamToken();
		const token = body?.stream_token;
		if (!token) {
			// An older Pi build authenticates fine but only sets the cookie, which
			// is useless cross-origin. Treat that as "mode B not supported here".
			return json({ available: false, reason: 'Pi returned no stream token' });
		}

		return json(
			{
				available: true,
				origin: publicUrl.replace(/\/+$/, ''),
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
