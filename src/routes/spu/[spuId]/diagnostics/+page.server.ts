import { error } from '@sveltejs/kit';
import { connectDB, Spu, DeviceLog, DeviceCrash, WebhookLog, DeviceEvent } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url, locals }) => {
	requirePermission(locals.user, 'device:read');
	await connectDB();

	// Load SPU to get the Particle device ID
	const spu = await Spu.findById(params.spuId).lean() as any;
	if (!spu) throw error(404, 'SPU not found');

	const particleDeviceId = spu.particleLink?.particleDeviceId;
	if (!particleDeviceId) {
		return {
			spu: { id: spu._id, udi: spu.udi },
			particleDeviceId: null,
			logs: [],
			crashes: [],
			webhookLogs: [],
			events: [],
			stats: { totalLogs: 0, totalCrashes: 0, lastUpload: null, avgWebhookTimeMs: null }
		};
	}

	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');

	// Build date filters per collection
	const dateRange: Record<string, any> = {};
	if (from) dateRange.$gte = new Date(from);
	if (to) dateRange.$lte = new Date(to + 'T23:59:59Z');
	const hasDateFilter = Object.keys(dateRange).length > 0;

	const logFilter: Record<string, any> = { deviceId: particleDeviceId };
	if (hasDateFilter) logFilter.uploadedAt = dateRange;

	const crashFilter: Record<string, any> = { deviceId: particleDeviceId };
	if (hasDateFilter) crashFilter.detectedAt = dateRange;

	const webhookFilter: Record<string, any> = { deviceId: particleDeviceId };
	if (hasDateFilter) webhookFilter.timestamp = dateRange;

	const eventFilter: Record<string, any> = { deviceId: particleDeviceId };
	if (hasDateFilter) eventFilter.createdAt = dateRange;

	const [logs, crashes, webhookLogs, events, webhookTimeAgg] = await Promise.all([
		DeviceLog.find(logFilter)
			.sort({ uploadedAt: -1 })
			.limit(50)
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
		WebhookLog.aggregate([
			{ $match: { deviceId: particleDeviceId, processingTimeMs: { $ne: null } } },
			{ $group: { _id: null, avg: { $avg: '$processingTimeMs' } } }
		])
	]);

	const totalCrashes = await DeviceCrash.countDocuments({ deviceId: particleDeviceId });
	const totalLogs = await DeviceLog.countDocuments({ deviceId: particleDeviceId });
	const lastUpload = logs[0]?.uploadedAt ?? null;
	const avgWebhookTimeMs = webhookTimeAgg[0]?.avg ? Math.round(webhookTimeAgg[0].avg) : null;

	return {
		spu: { id: spu._id, udi: spu.udi },
		particleDeviceId,
		logs: JSON.parse(JSON.stringify(logs)),
		crashes: JSON.parse(JSON.stringify(crashes)),
		webhookLogs: JSON.parse(JSON.stringify(webhookLogs)),
		events: JSON.parse(JSON.stringify(events)),
		stats: {
			totalLogs,
			totalCrashes,
			lastUpload,
			avgWebhookTimeMs
		}
	};
};
