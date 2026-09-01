import { json } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import { listDevices } from '$lib/server/particle';
import type { RequestHandler } from './$types';

// Live fleet connectivity for the /spu inventory (SPU-INV-04): one Particle call
// covering every device, keyed by particleDeviceId for client-side row merge.
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user || !hasPermission(locals.user, 'spu:read')) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const list = await listDevices();
		const devices: Record<
			string,
			{ online: boolean; lastHeard: string | null; firmwareVersion: string | null; systemVersion: string | null }
		> = {};
		for (const d of list) {
			devices[d.id] = {
				online: !!d.online,
				lastHeard: d.last_heard ?? null,
				firmwareVersion: d.firmware_version ?? null,
				systemVersion: d.system_firmware_version ?? null
			};
		}
		return json({ devices, fetchedAt: new Date().toISOString() });
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : 'Particle API unavailable' },
			{ status: 502 }
		);
	}
};
