/**
 * In-app event poll for the scanner test page.
 *
 * Browser → GET /api/scanner/events?deviceId=...&since=<isoTimestamp>&limit=50
 * Authenticated by user session + manufacturing:read.
 */
import { json, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ScannerEvent } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	requirePermission(locals.user, 'manufacturing:read');

	const deviceId = url.searchParams.get('deviceId')?.trim();
	const since = url.searchParams.get('since');
	const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));

	const query: any = {};
	if (deviceId) query.deviceId = deviceId;
	if (since) {
		const sinceDate = new Date(since);
		if (!isNaN(sinceDate.getTime())) query.receivedAt = { $gt: sinceDate };
	}

	await connectDB();
	const events = await ScannerEvent.find(query)
		.sort({ receivedAt: -1 })
		.limit(limit)
		.lean();

	// Last heartbeat per device — small extra query so the UI can show
	// online/offline status without scanning the full event list.
	const heartbeatQuery: any = { eventType: 'heartbeat' };
	if (deviceId) heartbeatQuery.deviceId = deviceId;
	const lastHeartbeat = await ScannerEvent.findOne(heartbeatQuery)
		.sort({ receivedAt: -1 })
		.select({ deviceId: 1, receivedAt: 1, metadata: 1 })
		.lean();

	return json({
		events: JSON.parse(JSON.stringify(events)),
		lastHeartbeat: JSON.parse(JSON.stringify(lastHeartbeat)),
		serverTime: new Date().toISOString()
	});
};
