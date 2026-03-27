import { connectDB, DeviceLog, DeviceCrash, WebhookLog, DeviceEvent } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url, locals }) => {
	requirePermission(locals.user, 'device:read');
	await connectDB();

	const { deviceId } = params;
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');

	// Build date filter
	const dateFilter: Record<string, any> = {};
	if (from || to) {
		if (from) dateFilter.$gte = new Date(from);
		if (to) dateFilter.$lte = new Date(to + 'T23:59:59Z');
	}

	const logFilter: Record<string, any> = { deviceId };
	if (Object.keys(dateFilter).length) logFilter.uploadedAt = dateFilter;

	const crashFilter: Record<string, any> = { deviceId };
	if (Object.keys(dateFilter).length) crashFilter.detectedAt = dateFilter;

	const webhookFilter: Record<string, any> = { deviceId };
	if (Object.keys(dateFilter).length) webhookFilter.timestamp = dateFilter;

	const eventFilter: Record<string, any> = { deviceId };
	if (Object.keys(dateFilter).length) eventFilter.createdAt = dateFilter;

	const [logs, crashes, webhookLogs, events, crashAgg, webhookTimeAgg] = await Promise.all([
		DeviceLog.find(logFilter)
			.sort({ uploadedAt: -1 })
			.limit(50)
			.select('sessionId firmwareVersion bootCount uploadedAt lineCount errorCount hasCrash firstLine lastLine')
			.lean(),
		DeviceCrash.find(crashFilter)
			.sort({ detectedAt: -1 })
			.lean(),
		WebhookLog.find(webhookFilter)
			.sort({ timestamp: -1 })
			.limit(100)
			.lean(),
		DeviceEvent.find(eventFilter)
			.sort({ createdAt: -1 })
			.limit(100)
			.lean(),
		// Most common crash category
		DeviceCrash.aggregate([
			{ $match: { deviceId } },
			{ $group: { _id: '$crashCategory', count: { $sum: 1 } } },
			{ $sort: { count: -1 } },
			{ $limit: 1 }
		]),
		// Average webhook processing time
		WebhookLog.aggregate([
			{ $match: { deviceId, processingTimeMs: { $ne: null } } },
			{ $group: { _id: null, avg: { $avg: '$processingTimeMs' } } }
		])
	]);

	const totalCrashes = crashes.length;
	const mostCommonCrashCategory = crashAgg[0]?._id ?? null;
	const avgWebhookTimeMs = webhookTimeAgg[0]?.avg ? Math.round(webhookTimeAgg[0].avg) : null;
	const lastCrash = crashes[0]?.detectedAt ?? null;

	return {
		deviceId,
		logs: JSON.parse(JSON.stringify(logs)),
		crashes: JSON.parse(JSON.stringify(crashes)),
		webhookLogs: JSON.parse(JSON.stringify(webhookLogs)),
		events: JSON.parse(JSON.stringify(events)),
		stats: {
			totalLogs: logs.length,
			totalCrashes,
			mostCommonCrashCategory,
			avgWebhookTimeMs,
			lastCrash
		},
		filters: {
			from: from || '',
			to: to || ''
		}
	};
};
