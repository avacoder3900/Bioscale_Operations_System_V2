/**
 * Barcode scanner test page — initial load + clear-history action.
 *
 * Pulls the latest 50 scanner_events for the selected device plus the
 * most recent heartbeat. The page then polls /api/scanner/events for
 * live updates.
 */
import { redirect, fail } from '@sveltejs/kit';
import { connectDB, ScannerEvent, ScannerTrigger } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

const DEFAULT_DEVICE_ID = 'lab-mac-scanner-1';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const deviceId = url.searchParams.get('deviceId')?.trim() || DEFAULT_DEVICE_ID;

	const [events, lastHeartbeat, knownDevices, pendingTriggers] = await Promise.all([
		ScannerEvent.find({ deviceId })
			.sort({ receivedAt: -1 })
			.limit(50)
			.lean(),
		ScannerEvent.findOne({ deviceId, eventType: 'heartbeat' })
			.sort({ receivedAt: -1 })
			.lean(),
		ScannerEvent.distinct('deviceId'),
		ScannerTrigger.countDocuments({ deviceId, consumedAt: null })
	]);

	return {
		deviceId,
		defaultDeviceId: DEFAULT_DEVICE_ID,
		events: JSON.parse(JSON.stringify(events)),
		lastHeartbeat: JSON.parse(JSON.stringify(lastHeartbeat)),
		knownDevices: knownDevices.length > 0 ? knownDevices : [DEFAULT_DEVICE_ID],
		pendingTriggers,
		serverTime: new Date().toISOString()
	};
};

export const actions: Actions = {
	clear: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not signed in' });
		requirePermission(locals.user, 'manufacturing:write');

		const data = await request.formData();
		const deviceId = data.get('deviceId')?.toString().trim();
		if (!deviceId) return fail(400, { error: 'deviceId required' });

		await connectDB();
		const eventResult = await ScannerEvent.deleteMany({ deviceId });
		const triggerResult = await ScannerTrigger.deleteMany({ deviceId });

		return {
			success: true,
			cleared: {
				events: eventResult.deletedCount ?? 0,
				triggers: triggerResult.deletedCount ?? 0
			}
		};
	}
};
