import { error } from '@sveltejs/kit';
import { connectDB, Spu, DeviceLog, DeviceCrash, WebhookLog, DeviceEvent } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

interface TimelineEntry {
	timestamp: string;
	source: 'firmware' | 'webhook' | 'crash' | 'event';
	data: any;
}

export const load: PageServerLoad = async ({ params, url, locals }) => {
	requirePermission(locals.user, 'device:read');
	await connectDB();

	const spu = await Spu.findById(params.spuId).lean() as any;
	if (!spu) throw error(404, 'SPU not found');

	const particleDeviceId = spu.particleLink?.particleDeviceId;
	if (!particleDeviceId) {
		return {
			spu: { id: spu._id, udi: spu.udi },
			particleDeviceId: null,
			timeline: [],
			logs: [],
			crashes: [],
			webhookLogs: [],
			events: [],
			stats: { totalLogs: 0, totalCrashes: 0, lastUpload: null, avgWebhookTimeMs: null },
			hasMore: false
		};
	}

	// Date range filter — default to last 24 hours
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	const now = new Date();
	const defaultFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);

	const dateFrom = from ? new Date(from) : defaultFrom;
	const dateTo = to ? new Date(to + 'T23:59:59Z') : now;

	const logFilter: Record<string, any> = { deviceId: particleDeviceId, uploadedAt: { $gte: dateFrom, $lte: dateTo } };
	const crashFilter: Record<string, any> = { deviceId: particleDeviceId, detectedAt: { $gte: dateFrom, $lte: dateTo } };
	const webhookFilter: Record<string, any> = { deviceId: particleDeviceId, timestamp: { $gte: dateFrom, $lte: dateTo } };
	const eventFilter: Record<string, any> = { deviceId: particleDeviceId, createdAt: { $gte: dateFrom, $lte: dateTo } };

	const [logs, crashes, webhookLogs, events, webhookTimeAgg] = await Promise.all([
		DeviceLog.find(logFilter).sort({ uploadedAt: 1 }).lean(),
		DeviceCrash.find(crashFilter).sort({ detectedAt: 1 }).lean(),
		WebhookLog.find(webhookFilter).sort({ timestamp: 1 }).lean(),
		DeviceEvent.find(eventFilter).sort({ createdAt: 1 }).lean(),
		WebhookLog.aggregate([
			{ $match: { deviceId: particleDeviceId, processingTimeMs: { $ne: null } } },
			{ $group: { _id: null, avg: { $avg: '$processingTimeMs' } } }
		])
	]);

	const totalCrashes = await DeviceCrash.countDocuments({ deviceId: particleDeviceId });
	const totalLogs = await DeviceLog.countDocuments({ deviceId: particleDeviceId });
	const lastUploadDoc = await DeviceLog.findOne({ deviceId: particleDeviceId }).sort({ uploadedAt: -1 }).select('uploadedAt').lean() as any;
	const avgWebhookTimeMs = webhookTimeAgg[0]?.avg ? Math.round(webhookTimeAgg[0].avg) : null;

	// Build unified timeline
	const timeline: TimelineEntry[] = [];

	// Group device_logs by bootCount to reconstruct continuous sessions.
	// Multiple upload chunks share the same bootCount — they're not separate reboots.
	// Only emit a session header when bootCount changes.
	let lastBootCount: number | null = null;
	let sessionLineCount = 0;
	let sessionUploadCount = 0;

	for (const log of logs as any[]) {
		const uploadTime = new Date(log.uploadedAt).getTime();
		const maxMs = log.logLines?.length > 0
			? Math.max(...log.logLines.map((l: any) => l.ms ?? 0))
			: 0;

		// Per-chunk anchor: the last line in this chunk was written at ~uploadedAt,
		// so the chunk's time origin is (uploadedAt - maxMs). Each line's wall-clock
		// is then (uploadedAt - maxMs + line.ms). This correctly interleaves firmware
		// lines with webhook/event timestamps that use server wall-clock time.
		const chunkOrigin = uploadTime - maxMs;

		// Emit session header only when bootCount changes (= real reboot)
		if (log.bootCount !== lastBootCount) {
			const displayName = log.deviceName || log.deviceId;
			const fwLabel = log.firmwareVersion != null ? `v${log.firmwareVersion}` : 'unknown';
			const bootLabel = log.bootCount != null ? `#${log.bootCount}` : 'unknown';

			// Session header timestamp = earliest line in this chunk
			const minMs = log.logLines?.length > 0
				? Math.min(...log.logLines.map((l: any) => l.ms ?? 0))
				: 0;

			timeline.push({
				timestamp: new Date(chunkOrigin + minMs).toISOString(),
				source: 'firmware',
				data: {
					ms: 0,
					message: `======== SESSION START ========\nBoot ${bootLabel} | ${displayName} | Firmware: ${fwLabel}`,
					sessionId: log.sessionId,
					isSessionHeader: true,
					firmwareVersion: log.firmwareVersion,
					bootCount: log.bootCount,
					deviceName: log.deviceName,
					uploadedAt: log.uploadedAt
				}
			});
			lastBootCount = log.bootCount;
			sessionLineCount = 0;
			sessionUploadCount = 0;
		}

		sessionUploadCount++;

		// Flatten log lines from this upload chunk into the timeline
		if (log.logLines) {
			for (const line of log.logLines) {
				const ts = new Date(chunkOrigin + (line.ms || 0));

				sessionLineCount++;
				timeline.push({
					timestamp: ts.toISOString(),
					source: 'firmware',
					data: { ms: line.ms, message: line.message, sessionId: log.sessionId }
				});
			}
		}
	}

	// Webhook logs
	for (const wh of webhookLogs as any[]) {
		timeline.push({
			timestamp: new Date(wh.timestamp).toISOString(),
			source: 'webhook',
			data: {
				eventName: wh.eventName,
				status: wh.response?.status ?? null,
				processingTimeMs: wh.processingTimeMs ?? null,
				errorMessage: wh.response?.errorMessage ?? null,
				request: wh.request ?? null,
				response: wh.response ?? null,
				_id: wh._id
			}
		});
	}

	// Crashes
	for (const cr of crashes as any[]) {
		timeline.push({
			timestamp: new Date(cr.detectedAt).toISOString(),
			source: 'crash',
			data: {
				lastCheckpoint: cr.lastCheckpoint,
				lastCheckpointName: cr.lastCheckpointName,
				crashCategory: cr.crashCategory,
				checkpointSequence: cr.checkpointSequence ?? [],
				firmwareVersion: cr.firmwareVersion,
				bootCount: cr.bootCount,
				sessionLogId: cr.sessionLogId,
				_id: cr._id
			}
		});
	}

	// Events
	for (const ev of events as any[]) {
		timeline.push({
			timestamp: new Date(ev.createdAt).toISOString(),
			source: 'event',
			data: {
				eventType: ev.eventType,
				eventData: ev.eventData,
				_id: ev._id
			}
		});
	}

	// Sort by timestamp descending (newest first)
	timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

	// Check if there's more data outside the window
	const totalInWindow = timeline.length;
	const hasMore = totalInWindow >= 500;

	// Reverse tab data so newest appears first (queries are ascending for timeline stitching)
	const logsDesc = [...logs].reverse();
	const crashesDesc = [...crashes].reverse();
	const webhookLogsDesc = [...webhookLogs].reverse();
	const eventsDesc = [...events].reverse();

	return {
		spu: { id: spu._id, udi: spu.udi },
		particleDeviceId,
		timeline: JSON.parse(JSON.stringify(timeline)),
		logs: JSON.parse(JSON.stringify(logsDesc)),
		crashes: JSON.parse(JSON.stringify(crashesDesc)),
		webhookLogs: JSON.parse(JSON.stringify(webhookLogsDesc)),
		events: JSON.parse(JSON.stringify(eventsDesc)),
		stats: {
			totalLogs,
			totalCrashes,
			lastUpload: lastUploadDoc?.uploadedAt ?? null,
			avgWebhookTimeMs
		},
		dateRange: {
			from: dateFrom.toISOString().split('T')[0],
			to: dateTo.toISOString().split('T')[0]
		},
		hasMore
	};
};
