// Robot-arm tunnel registration.
//
// The Pi runs a Cloudflare quick tunnel (services/robot-arm/scripts/arm-tunnel)
// as a second route alongside the Tailscale Funnel. Quick-tunnel URLs are
// random and change on every restart, so the Pi POSTs its current URL here on
// change and every few minutes as a heartbeat. robot-arm-client.ts reads it.
//
// Auth is the shared ROBOT_ARM_API_KEY, the same secret BIMS already sends to
// the Pi. The URL must be a *.trycloudflare.com origin: BIMS sends that key to
// whatever URL is stored here, so nothing else may ever be accepted.

import { json } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { connectDB } from '$lib/server/db/connection';
import { AuditLog, generateId } from '$lib/server/db';
import { RobotArmEndpoint } from '$lib/server/db/models';
import { invalidateTunnelCache } from '$lib/server/robot-arm-client';
import type { RequestHandler } from './$types';

const TUNNEL_URL_RE = /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/;

function keyMatches(given: string | null): boolean {
	const expected = env.ROBOT_ARM_API_KEY ?? '';
	if (!given || !expected) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

export const POST: RequestHandler = async ({ request }) => {
	if (!keyMatches(request.headers.get('x-api-key'))) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = (await request.json().catch(() => null)) as { url?: unknown } | null;
	const url = typeof body?.url === 'string' ? body.url.trim().replace(/\/$/, '') : '';
	if (!TUNNEL_URL_RE.test(url) || url.startsWith('https://api.')) {
		return json({ error: 'url must be an https://<name>.trycloudflare.com origin' }, { status: 400 });
	}

	await connectDB();
	const now = new Date();
	const previous = (await RobotArmEndpoint.findById('tunnel').lean()) as { url?: string } | null;
	const changed = previous?.url !== url;

	await RobotArmEndpoint.updateOne(
		{ _id: 'tunnel' },
		{
			$set: {
				url,
				registeredAt: now,
				...(changed ? { previousUrl: previous?.url ?? null } : {})
			}
		},
		{ upsert: true }
	);

	// Heartbeats with an unchanged URL only bump registeredAt; audit the changes.
	if (changed) {
		await AuditLog.create({
			_id: generateId(),
			tableName: 'robot_arm_endpoints',
			recordId: 'tunnel',
			action: 'UPDATE',
			oldData: { url: previous?.url ?? null },
			newData: { url },
			changedBy: 'robot-arm-pi'
		});
	}
	invalidateTunnelCache();

	return json({ ok: true, changed });
};
