/**
 * Mocreo gateway heartbeat — runs every 30 minutes to detect cascade/power
 * loss and re-email until the gateway comes back online.
 *
 * Distinct from /api/cron/mocreo (5-min data sync). The data sync owns
 * pulling readings; this heartbeat owns the *reminder cadence*. It works
 * purely off the local database (no MOCREO API call) so it still detects
 * outages even if the upstream sync itself is failing — i.e. it answers
 * "is BIMS still receiving data?" rather than "is MOCREO reachable from
 * here right now?"
 *
 * Lifecycle of a gateway_outage alert across both crons:
 *   t=0      5-min sync detects outage → creates alert + sends initial email
 *            (lastNotifiedAt=t0, notificationCount=1)
 *   t=30m+   heartbeat sees alert still unacked + lastNotifiedAt ≥ 25min
 *            ago → sends reminder #1, bumps notificationCount=2
 *   t=60m+   heartbeat sends reminder #2, ...
 *   t=Nm     readings start coming back in → either the 5-min sync or the
 *            heartbeat auto-resolves (sets resolvedAt + acknowledged=true)
 *            and fires a one-shot recovery email
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireAgentApiKey } from '$lib/server/api-auth';
import {
	connectDB, generateId, Equipment, TemperatureReading, TemperatureAlert, SensorConfig
} from '$lib/server/db';
import { notifyGatewayOutage, notifyGatewayRecovered } from '$lib/server/notifications';

const SILENT_THRESHOLD_MS = 30 * 60 * 1000;       // probe is "silent" if no reading in 30 min
const REMINDER_INTERVAL_MS = 25 * 60 * 1000;       // re-email if last notify ≥ 25 min ago (cron is */30)
const GATEWAY_OUTAGE_FRACTION = 0.5;               // ≥50% silent = gateway-wide event
const EXPECTED_PROBES_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function authenticate(request: Request): void {
	// CRON_SECRET Bearer (Vercel sends it automatically when the env var is set)
	// or the agent API key. No user-agent fallback — that header is forgeable.
	const authHeader = request.headers.get('authorization')?.replace('Bearer ', '');
	if (env.CRON_SECRET && authHeader === env.CRON_SECRET) return;
	requireAgentApiKey(request);
}

interface ProbeHealth {
	sensorId: string;
	sensorName: string | null;
	equipmentName: string | null;
	latestReadingAt: Date | null;
	silent: boolean;
}

/**
 * Build the "expected probes" set from the union of:
 *   - SensorConfig docs (operator-configured)
 *   - Equipment with mocreoDeviceId set (probe-mapped equipment)
 *   - Distinct sensorIds that have reported in the past 7 days
 *
 * Then for each, look up the most recent TemperatureReading.timestamp.
 */
async function getProbeHealthFromDb(now: Date): Promise<ProbeHealth[]> {
	const lookbackCutoff = new Date(now.getTime() - EXPECTED_PROBES_LOOKBACK_MS);

	const [sensorConfigs, mappedEquipment, recentSensors] = await Promise.all([
		SensorConfig.find().select('_id sensorName').lean() as any as Promise<any[]>,
		Equipment.find({ mocreoDeviceId: { $ne: null } })
			.select('mocreoDeviceId name').lean() as any as Promise<any[]>,
		TemperatureReading.aggregate([
			{ $match: { timestamp: { $gte: lookbackCutoff } } },
			{ $group: {
				_id: '$sensorId',
				latestReadingAt: { $max: '$timestamp' },
				sensorName: { $last: '$sensorName' }
			}}
		])
	]);

	// Index helpers
	const recentMap = new Map<string, { latestReadingAt: Date; sensorName: string | null }>();
	for (const r of recentSensors as any[]) {
		recentMap.set(r._id, { latestReadingAt: r.latestReadingAt, sensorName: r.sensorName ?? null });
	}
	const equipmentByDevice = new Map<string, any>();
	for (const eq of mappedEquipment) {
		if (eq.mocreoDeviceId) equipmentByDevice.set(eq.mocreoDeviceId, eq);
	}

	// Union of all known sensor IDs
	const sensorIds = new Set<string>();
	for (const sc of sensorConfigs) sensorIds.add(sc._id);
	for (const id of equipmentByDevice.keys()) sensorIds.add(id);
	for (const id of recentMap.keys()) sensorIds.add(id);

	// For sensors not in the recent-readings aggregation, fall back to a
	// per-sensor lookup so a probe that's been silent > 7 days still surfaces
	// as silent (rather than dropping out entirely).
	const probes: ProbeHealth[] = [];
	for (const sensorId of sensorIds) {
		const cfg = sensorConfigs.find((sc: any) => sc._id === sensorId);
		const eq = equipmentByDevice.get(sensorId);
		const recent = recentMap.get(sensorId);

		let latestReadingAt: Date | null = recent?.latestReadingAt ?? null;
		if (!latestReadingAt) {
			const last = await TemperatureReading.findOne({ sensorId })
				.select('timestamp').sort({ timestamp: -1 }).lean() as any;
			latestReadingAt = last?.timestamp ?? null;
		}
		const silent = !latestReadingAt
			|| (now.getTime() - latestReadingAt.getTime()) > SILENT_THRESHOLD_MS;

		probes.push({
			sensorId,
			sensorName: cfg?.sensorName ?? recent?.sensorName ?? eq?.name ?? null,
			equipmentName: eq?.name ?? null,
			latestReadingAt,
			silent
		});
	}
	return probes;
}

export async function runMocreoHeartbeat(request: Request, url: URL) {
	const ua = request.headers.get('user-agent') ?? '';
	const src = ua.startsWith('vercel-cron/') ? 'vercel-cron'
		: request.headers.get('authorization') ? 'bearer'
		: (request.headers.get('x-api-key') || request.headers.get('x-agent-api-key')) ? 'api-key'
		: 'unknown';
	console.log(`[MOCREO HEARTBEAT] start path=${url.pathname} method=${request.method} src=${src}`);

	if (url.searchParams.get('health') === '1') {
		authenticate(request);
		return json({ ok: true, authVia: src, path: url.pathname });
	}

	authenticate(request);
	await connectDB();
	const now = new Date();

	const probes = await getProbeHealthFromDb(now);
	const silentProbes = probes.filter(p => p.silent);
	const freshProbes = probes.filter(p => !p.silent);
	const totalProbes = probes.length;

	// Three signal states:
	//   haveSignal=false → we can't see anything (no probes registered, or
	//                      the lookback window is empty). Don't transition
	//                      states based on this; keep an open alert open.
	//   isOutage=true   → ≥50% of known probes are silent.
	//   isRecovered     → we have signal AND we're not in outage state.
	const haveSignal = totalProbes > 0;
	const isOutage = haveSignal && silentProbes.length / totalProbes >= GATEWAY_OUTAGE_FRACTION;
	const isRecovered = haveSignal && !isOutage;

	console.log(`[MOCREO HEARTBEAT] probes=${totalProbes} silent=${silentProbes.length} fresh=${freshProbes.length} haveSignal=${haveSignal} isOutage=${isOutage} isRecovered=${isRecovered}`);

	const existingAlert = await TemperatureAlert.findOne({
		alertType: 'gateway_outage',
		acknowledged: false,
		resolvedAt: { $exists: false }
	}).sort({ timestamp: -1 }).lean() as any;

	// --- Recovery branch: gateway is back, but an outage alert is still open ---
	// Requires positive evidence (haveSignal && !isOutage). If we can't see any
	// probes, we *don't* assume recovery — that would falsely fire a recovery
	// email when the system is actually still down past the lookback window.
	if (isRecovered && existingAlert) {
		await TemperatureAlert.updateOne({ _id: existingAlert._id }, {
			$set: {
				acknowledged: true,
				acknowledgedAt: now,
				resolvedAt: now,
				resolvedReason: 'auto-resolved: gateway recovered (heartbeat)'
			}
		});
		await notifyGatewayRecovered({
			recoveredAt: now,
			firstSeenAt: existingAlert.timestamp,
			totalReminders: Math.max(0, (existingAlert.notificationCount ?? 1) - 1),
			totalSensors: totalProbes
		});
		console.log(`[MOCREO HEARTBEAT] auto-resolved alert ${existingAlert._id}`);
		return json({ ok: true, action: 'recovered', alertId: existingAlert._id, totalProbes, silentProbes: silentProbes.length });
	}

	// --- Reminder branch: alert is open AND we have NOT recovered ---
	// Covers both confirmed outage (isOutage=true) and unknown state
	// (haveSignal=false). The alert was created when probes existed, so
	// something IS down — keep operators informed on the 30-min cadence
	// until we get positive evidence the gateway is back.
	if (existingAlert && !isRecovered) {
		const last = existingAlert.lastNotifiedAt
			? new Date(existingAlert.lastNotifiedAt).getTime()
			: new Date(existingAlert.timestamp).getTime();
		const sinceLast = now.getTime() - last;
		if (sinceLast < REMINDER_INTERVAL_MS) {
			console.log(`[MOCREO HEARTBEAT] outage active but only ${Math.round(sinceLast / 60000)}m since last notify (need ≥${REMINDER_INTERVAL_MS / 60000}m); skipping reminder`);
			return json({ ok: true, action: 'reminder_throttled', sinceLastMin: Math.round(sinceLast / 60000) });
		}

		const nextCount = (existingAlert.notificationCount ?? 1) + 1;
		await TemperatureAlert.updateOne({ _id: existingAlert._id }, {
			$set: { lastNotifiedAt: now, notificationCount: nextCount }
		});
		await notifyGatewayOutage({
			timestamp: now,
			totalSensors: totalProbes,
			silentSensors: silentProbes.map(p => ({
				sensorId: p.sensorId,
				sensorName: p.sensorName ?? p.sensorId,
				equipmentName: p.equipmentName
			})),
			firstSeenAt: existingAlert.timestamp,
			reminderNumber: nextCount
		});
		console.log(`[MOCREO HEARTBEAT] sent reminder #${nextCount - 1} for alert ${existingAlert._id}`);
		return json({ ok: true, action: 'reminder_sent', reminderNumber: nextCount - 1, alertId: existingAlert._id });
	}

	// --- Outage but no existing alert: defensive create (5-min sync didn't fire) ---
	// Requires confirmed outage signal. Won't fire on haveSignal=false because
	// that's an unknown state — emailing a "Gateway outage" warning when we
	// can't actually see any probes would be a false alarm.
	if (isOutage && !existingAlert) {
		const alertId = generateId();
		await TemperatureAlert.create({
			_id: alertId,
			sensorId: 'gateway',
			sensorName: 'Mocreo Gateway',
			alertType: 'gateway_outage',
			threshold: null,
			actualValue: null,
			equipmentId: null,
			equipmentName: 'Mocreo Gateway',
			timestamp: now,
			gatewayEvent: true,
			affectedSensorIds: silentProbes.map(p => p.sensorId),
			lastNotifiedAt: now,
			notificationCount: 1
		});
		await notifyGatewayOutage({
			timestamp: now,
			totalSensors: totalProbes,
			silentSensors: silentProbes.map(p => ({
				sensorId: p.sensorId,
				sensorName: p.sensorName ?? p.sensorId,
				equipmentName: p.equipmentName
			}))
		});
		console.log(`[MOCREO HEARTBEAT] created defensive outage alert ${alertId} (5-min sync may be down)`);
		return json({ ok: true, action: 'created', alertId, totalProbes, silentProbes: silentProbes.length });
	}

	// --- All quiet: gateway healthy, no open alert ---
	return json({ ok: true, action: 'healthy', totalProbes, silentProbes: silentProbes.length });
}
