import { json } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import { listDevices, listProducts, listAllProductDevices } from '$lib/server/particle';
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

		// Product-fleet enrichment: the user-scoped list above returns no
		// firmware_version for product devices — only the product endpoints carry
		// the console's "vNN" number (and the "vNN → vMM" pending-update state).
		// Best-effort: a failure here still returns the base connectivity data.
		try {
			const products = await listProducts();
			for (const p of products) {
				const pdevs = await listAllProductDevices(p.id ?? p.slug ?? '');
				for (const d of pdevs) {
					if (!d?.id) continue;
					const entry = (devices[d.id] ??= {
						online: !!d.online,
						lastHeard: null,
						firmwareVersion: null,
						systemVersion: null
					});
					const fw = d.firmware_version;
					const desired = d.desired_firmware_version;
					if (fw !== null && fw !== undefined) {
						entry.firmwareVersion = `v${fw}`;
						if (desired !== null && desired !== undefined && String(desired) !== String(fw)) {
							entry.firmwareVersion += ` → v${desired}`;
						}
					}
					if (!entry.systemVersion && d.system_firmware_version) {
						entry.systemVersion = d.system_firmware_version;
					}
					const heard = d.last_heard ?? d.last_handshake_at;
					if (!entry.lastHeard && heard) entry.lastHeard = heard;
				}
			}
		} catch {
			// keep base data
		}

		return json({ devices, fetchedAt: new Date().toISOString() });
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : 'Particle API unavailable' },
			{ status: 502 }
		);
	}
};
