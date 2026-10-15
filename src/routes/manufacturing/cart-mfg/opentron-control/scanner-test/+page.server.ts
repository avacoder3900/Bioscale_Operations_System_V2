/**
 * Barcode scanner test page — initial load + clear-history action.
 *
 * Pulls the latest 50 scanner_events for the selected device plus the
 * most recent heartbeat. The page then polls /api/scanner/events for
 * live updates.
 */
import { redirect, fail } from '@sveltejs/kit';
import { connectDB, OpentronsRobot, ScannerEvent, ScannerTrigger } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';
import type { PageServerLoad, Actions } from './$types';

const DEFAULT_DEVICE_ID = 'lab-mac-scanner-1';

/**
 * The scanner ids an OT-2's daemon reports under (ot2-bridge.py
 * _default_scanner_device_id): its bridge id with '-bridge' → '-scanner'
 * (bridgeDeviceId when set, else ot2-<slot>-bridge from the name), plus the
 * name-only form the teach panel uses. An unresolvable robot maps to nothing.
 */
function scannerDeviceIdsForRobot(robot: { name?: string; bridgeDeviceId?: string }): string[] {
	const ids = new Set<string>();
	const bridgeId = bridgeDeviceIdForRobot(robot);
	if (bridgeId !== 'unknown-bridge') ids.add(bridgeId.endsWith('-bridge') ? bridgeId.slice(0, -'-bridge'.length) + '-scanner' : `${bridgeId}-scanner`);
	const slot = (robot.name ?? '').match(/\b([A-Z]\d{2})\b/)?.[1]?.toLowerCase();
	if (slot) ids.add(`ot2-${slot}-scanner`);
	return [...ids];
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const deviceId = url.searchParams.get('deviceId')?.trim() || DEFAULT_DEVICE_ID;

	const [events, lastHeartbeat, knownDevices, pendingTriggers, robots] = await Promise.all([
		ScannerEvent.find({ deviceId })
			.sort({ receivedAt: -1 })
			.limit(50)
			.lean(),
		ScannerEvent.findOne({ deviceId, eventType: 'heartbeat' })
			.sort({ receivedAt: -1 })
			.lean(),
		ScannerEvent.distinct('deviceId'),
		ScannerTrigger.countDocuments({ deviceId, consumedAt: null }),
		OpentronsRobot.find({ isActive: { $ne: false } }).select('_id name bridgeDeviceId').lean()
	]);

	// OT2-TAILNET-5 S6: which OT-2 owns this scanner, so the page can open a
	// robot session and run the test scan on the daemon's /bridge/scan when that
	// robot is on the tailnet line. null = no robot → today's queue trigger only.
	// The daemon-derived id (index 0) wins over the name-only form; a scanner id
	// two robots claim equally maps to NO robot (queue trigger only) rather than
	// guessing which daemon to fire.
	const plain = JSON.parse(JSON.stringify(robots)) as Array<{ _id: string; name?: string; bridgeDeviceId?: string }>;
	const primary = plain.filter((r) => scannerDeviceIdsForRobot(r)[0] === deviceId);
	const anyMatch = plain.filter((r) => scannerDeviceIdsForRobot(r).includes(deviceId));
	const candidates = primary.length > 0 ? primary : anyMatch;
	const owner = candidates.length === 1 ? candidates[0] : undefined;

	return {
		deviceId,
		defaultDeviceId: DEFAULT_DEVICE_ID,
		events: JSON.parse(JSON.stringify(events)),
		lastHeartbeat: JSON.parse(JSON.stringify(lastHeartbeat)),
		knownDevices: knownDevices.length > 0 ? knownDevices : [DEFAULT_DEVICE_ID],
		pendingTriggers,
		scannerRobot: owner ? { robotId: String(owner._id), name: owner.name ?? String(owner._id) } : null,
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
