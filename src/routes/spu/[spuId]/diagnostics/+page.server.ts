import { error, fail } from '@sveltejs/kit';
import { connectDB, Spu, DeviceLog, DeviceCrash, WebhookLog, DeviceFinding } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { buildDeviceTimeline } from '$lib/server/device-timeline';
import { syncMonitorFlag } from '$lib/server/service-flag';
import { appendSpuJournal } from '$lib/server/spu-journal';
import { reviewDevice, listMonitoredSpus } from '$lib/server/device-monitor-review';
import type { Actions, PageServerLoad } from './$types';

function monitoringView(spu: any) {
	const m = spu.monitoring ?? {};
	const pl = spu.particleLink ?? {};
	return {
		enabled: !!m.enabled,
		role: m.role ?? 'suspect',
		reason: m.reason ?? '',
		enabledAt: m.enabledAt ?? null,
		enabledBy: m.enabledBy?.username ?? null,
		lastReviewAt: m.lastReviewAt ?? null,
		lastReviewStatus: m.lastReviewStatus ?? null,
		flag: pl.monitorFlag ?? null,
		flagState: pl.monitorFlagState ?? null,
		flagSyncedAt: pl.monitorFlagSyncedAt ?? null,
		flagError: pl.monitorFlagError ?? null
	};
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
			monitoring: monitoringView(spu),
			findings: [],
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

	const [tl, webhookTimeAgg, totalCrashes, totalLogs, lastUploadDoc, findings] = await Promise.all([
		buildDeviceTimeline(particleDeviceId, dateFrom, dateTo),
		WebhookLog.aggregate([
			{ $match: { deviceId: particleDeviceId, processingTimeMs: { $ne: null } } },
			{ $group: { _id: null, avg: { $avg: '$processingTimeMs' } } }
		]),
		DeviceCrash.countDocuments({ deviceId: particleDeviceId }),
		DeviceLog.countDocuments({ deviceId: particleDeviceId }),
		DeviceLog.findOne({ deviceId: particleDeviceId }).sort({ uploadedAt: -1 }).select('uploadedAt').lean() as any,
		// Findings are not date-filtered: the whole point is that they outlive the raw data.
		DeviceFinding.find({ deviceId: particleDeviceId }).sort({ createdAt: -1 }).limit(200).lean() as any
	]);
	const avgWebhookTimeMs = webhookTimeAgg[0]?.avg ? Math.round(webhookTimeAgg[0].avg) : null;

	const hasMore = tl.timeline.length >= 500;

	return {
		spu: { id: spu._id, udi: spu.udi },
		particleDeviceId,
		monitoring: monitoringView(spu),
		findings: JSON.parse(JSON.stringify(findings)),
		timeline: JSON.parse(JSON.stringify(tl.timeline)),
		logs: JSON.parse(JSON.stringify([...tl.logs].reverse())),
		crashes: JSON.parse(JSON.stringify([...tl.crashes].reverse())),
		webhookLogs: JSON.parse(JSON.stringify([...tl.webhookLogs].reverse())),
		events: JSON.parse(JSON.stringify([...tl.events].reverse())),
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

export const actions: Actions = {
	// Turn monitor mode on/off for this unit. Writes the policy to the SPU, journals it,
	// and pushes the flag to the device (best effort; the spark/status online handler and
	// the Resync button retry it).
	setMonitor: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const fd = await request.formData();
		const enabled = fd.get('enabled') === '1';
		const role = fd.get('role') === 'control' ? 'control' : 'suspect';
		const reason = String(fd.get('reason') ?? '').trim().slice(0, 500);
		const spu = await Spu.findById(params.spuId).select('udi monitoring').lean() as any;
		if (!spu) return fail(404, { error: 'SPU not found' });

		const actor = { _id: locals.user!._id, username: locals.user!.username };
		const set: Record<string, any> = { 'monitoring.enabled': enabled, 'monitoring.role': role };
		if (enabled) {
			set['monitoring.reason'] = reason;
			set['monitoring.enabledAt'] = new Date();
			set['monitoring.enabledBy'] = actor;
			set['monitoring.disabledAt'] = null;
		} else {
			set['monitoring.disabledAt'] = new Date();
		}
		await Spu.updateOne({ _id: params.spuId }, { $set: set });
		await appendSpuJournal(
			params.spuId,
			enabled ? `Monitor mode ON (${role})${reason ? ` — ${reason}` : ''}` : 'Monitor mode OFF',
			actor,
			{ source: 'service', refKind: 'monitoring' }
		);
		const flag = await syncMonitorFlag(params.spuId);
		return { monitorSaved: true, flag };
	},

	resyncMonitor: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const flag = await syncMonitorFlag(params.spuId);
		return { monitorResynced: true, flag };
	},

	// Run the daily review for this unit now (last 24 h), without waiting for the cron.
	reviewNow: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		const all = await listMonitoredSpus();
		const me = all.find((s) => s._id === params.spuId);
		if (!me) return fail(400, { error: 'Monitor mode is not enabled on this unit, or no device is linked.' });
		const to = new Date();
		const from = new Date(to.getTime() - 24 * 3600 * 1000);
		const result = await reviewDevice(me, { from, to, controls: all.filter((s) => s.role === 'control') });
		if (result.error) return fail(502, { error: result.error });
		return { reviewed: true, review: { status: result.status, summary: result.summary, findingCount: result.findingCount, costUsd: result.costUsd } };
	},

	ackFinding: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const fd = await request.formData();
		const id = String(fd.get('findingId') ?? '');
		const resolve = fd.get('resolve') === '1';
		if (!id) return fail(400, { error: 'findingId required' });
		const actor = { _id: locals.user!._id, username: locals.user!.username };
		const set: Record<string, any> = { acknowledgedAt: new Date(), acknowledgedBy: actor };
		if (resolve) set.resolvedAt = new Date();
		await DeviceFinding.updateOne({ _id: id, spuId: params.spuId }, { $set: set });
		return { acknowledged: true };
	}
};
