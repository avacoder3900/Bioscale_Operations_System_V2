/**
 * ARM-02 — Robot arm camera snapshot proxy.
 *
 * The browser polls this route; this route talks to the Pi. That indirection
 * is the whole point (ARM-01 G0): the operator's device only ever needs to
 * reach BIMS over ordinary HTTPS, so a phone on cellular with no Tailscale
 * client sees the same feed as a laptop on the lab LAN. ROBOT_ARM_BASE_URL
 * and ROBOT_ARM_API_KEY never leave the server.
 *
 * Snapshot-polling rather than proxying the Pi's MJPEG stream: a multipart
 * stream is long-lived, and svelte.config.js caps the adapter at
 * maxDuration 30 — so a proxied stream would be severed every 30s and would
 * pin one function instance per viewer for its whole life. Each snapshot is
 * one short bounded request instead.
 */
import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { robotArm } from '$lib/server/robot-arm-client';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const name = params.name;
	if (!name) error(400, 'Camera name required');

	try {
		const { bytes, contentType } = await robotArm.getCameraSnapshot(name);
		return new Response(bytes, {
			headers: {
				'Content-Type': contentType,
				// Every frame is a distinct image at the same URL. Any caching
				// layer that holds one turns a live feed into a still, which is
				// the dangerous failure mode for a machine that moves.
				'Cache-Control': 'no-store, no-cache, must-revalidate',
				'Content-Length': String(bytes.byteLength)
			}
		});
	} catch (err) {
		// Surface upstream text to the client as a status only. The message can
		// contain the Pi's base URL, which the browser must never learn.
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error(`[arm-camera] snapshot "${name}" failed:`, message);
		error(502, 'Camera unavailable');
	}
};
