/**
 * Mocreo probe sync — shared implementation.
 *
 * Called by both /api/mocreo/sync (legacy path, retained for the openclaw
 * worker and manual triggers) and /api/cron/mocreo (fresh path used by
 * Vercel Cron). Keeping the logic here lets us register a brand-new cron
 * entry without duplicating code.
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, generateId, Equipment, TemperatureReading, TemperatureAlert, SensorConfig } from '$lib/server/db';
import {
	fetchAllSensors,
	fetchLatestReading,
	rawToC,
	rawToHumidity
} from '$lib/server/services/mocreo';
import { notifyTemperatureAlert, notifyGatewayOutage } from '$lib/server/notifications';

const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
// If this fraction of sensors go silent in the same sync, treat as a gateway/power
// event and emit ONE consolidated notification instead of N per-sensor emails.
// 0.5 = half or more.
const GATEWAY_OUTAGE_FRACTION = 0.5;

function authenticateSync(request: Request): void {
	// 1) Explicit CRON_SECRET Bearer (preferred — set in Vercel env).
	const authHeader = request.headers.get('authorization')?.replace('Bearer ', '');
	if (env.CRON_SECRET && authHeader === env.CRON_SECRET) return;

	// 2) Vercel Cron user-agent fallback. Vercel fires cron requests with
	//    user-agent "vercel-cron/1.0"; if CRON_SECRET isn't configured the
	//    Bearer header is absent. GET only — POST still requires the agent key.
	if (request.method === 'GET') {
		const ua = request.headers.get('user-agent') ?? '';
		if (ua.startsWith('vercel-cron/')) return;
	}

	// 3) Fall back to agent API key auth (openclaw, worker scripts).
	requireAgentApiKey(request);
}

async function checkLostConnection(
	sensorId: string,
	sensorName: string,
	eq: any,
	now: Date,
	gatewayEvent: boolean
): Promise<boolean> {
	const existing = await TemperatureAlert.findOne({
		sensorId,
		alertType: 'lost_connection',
		acknowledged: false
	});
	if (existing) return false;

	await TemperatureAlert.create({
		_id: generateId(),
		sensorId,
		sensorName,
		alertType: 'lost_connection',
		threshold: null,
		actualValue: null,
		equipmentId: eq ? String(eq._id) : null,
		equipmentName: eq?.name ?? null,
		timestamp: now,
		gatewayEvent
	});
	return true;
}

export async function runMocreoSync(request: Request, url: URL) {
	// Breadcrumb so Vercel logs show whether cron invocations arrive at all.
	// A missing line here every 5 minutes = cron not firing (Vercel side).
	const ua = request.headers.get('user-agent') ?? '';
	const src = ua.startsWith('vercel-cron/')
		? 'vercel-cron'
		: request.headers.get('authorization')
		? 'bearer'
		: (request.headers.get('x-api-key') || request.headers.get('x-agent-api-key'))
		? 'api-key'
		: 'unknown';
	const path = url.pathname;
	console.log(`[MOCREO SYNC] start path=${path} method=${request.method} src=${src} ua="${ua}"`);

	// Health mode — no DB writes, no Mocreo fetch. Lets us verify auth + env
	// config without triggering a full sync. Hit with ?health=1.
	if (url.searchParams.get('health') === '1') {
		authenticateSync(request);
		const envCheck = {
			MOCREO_EMAIL: !!env.MOCREO_EMAIL,
			MOCREO_PASSWORD: !!env.MOCREO_PASSWORD,
			CRON_SECRET: !!env.CRON_SECRET,
			AGENT_API_KEY: !!env.AGENT_API_KEY,
			MONGODB_URI: !!env.MONGODB_URI
		};
		return json({ ok: true, envCheck, authVia: src, path });
	}

	try {
		authenticateSync(request);
	} catch (err: any) {
		console.error(`[MOCREO SYNC] auth failed src=${src}:`, err?.message ?? err);
		throw err;
	}
	await connectDB();

	let sensors: Awaited<ReturnType<typeof fetchAllSensors>>;
	try {
		sensors = await fetchAllSensors();
	} catch (err: any) {
		console.error('[MOCREO SYNC] fetchAllSensors failed:', err);
		return json(
			{ success: false, error: err?.message ?? String(err), stage: 'fetchAllSensors' },
			{ status: 502 }
		);
	}
	console.log(`[MOCREO SYNC] fetched ${sensors.length} sensors from Mocreo API`);

	const results: Array<{
		sensorId: string;
		sensorName: string;
		temperature: number | null;
		humidity: number | null;
		equipmentId: string | null;
		alerts: string[];
		error?: string;
	}> = [];

	const equipmentDocs = await Equipment.find({ mocreoDeviceId: { $ne: null } })
		.select('_id mocreoDeviceId name temperatureMinC temperatureMaxC')
		.lean() as any[];
	const sensorToEquipment = new Map<string, any>();
	for (const eq of equipmentDocs) {
		if (eq.mocreoDeviceId) sensorToEquipment.set(eq.mocreoDeviceId, eq);
	}

	const sensorConfigs = await SensorConfig.find().lean() as any[];
	const sensorConfigMap = new Map<string, any>();
	for (const sc of sensorConfigs) sensorConfigMap.set(sc._id, sc);

	const now = new Date();

	// Pre-fetch all latest readings so we can detect gateway-wide outages
	// (most/all probes silent at once = power/network loss, not individual probes).
	// Doing this in one pass lets us emit ONE consolidated email instead of N.
	type Prefetch = { sample: Awaited<ReturnType<typeof fetchLatestReading>>; fetchError?: any };
	const prefetched = new Map<string, Prefetch>();
	await Promise.all(sensors.map(async (s) => {
		try {
			const sample = await fetchLatestReading(s.thingName);
			prefetched.set(s.thingName, { sample });
		} catch (err) {
			prefetched.set(s.thingName, { sample: null, fetchError: err });
		}
	}));

	const silentSensors = sensors.filter((s) => {
		const p = prefetched.get(s.thingName);
		if (!p?.sample) return true;
		const ageMs = now.getTime() - p.sample.time * 1000;
		return ageMs > OFFLINE_THRESHOLD_MS;
	});
	const isGatewayEvent = sensors.length > 0
		&& silentSensors.length / sensors.length >= GATEWAY_OUTAGE_FRACTION;

	if (isGatewayEvent) {
		console.warn(`[MOCREO SYNC] gateway-event detected: ${silentSensors.length}/${sensors.length} sensors silent — consolidating notifications`);
	}

	for (const sensor of sensors) {
		const alertsCreated: string[] = [];
		const eq = sensorToEquipment.get(sensor.thingName);
		const equipmentId = eq ? String(eq._id) : null;

		try {
			const pre = prefetched.get(sensor.thingName);
			if (pre?.fetchError) throw pre.fetchError;
			const sample = pre?.sample ?? null;
			if (!sample) {
				const created = await checkLostConnection(sensor.thingName, sensor.name, eq, now, isGatewayEvent);
				// Suppress per-sensor email when this is a gateway-wide event;
				// one consolidated email is sent after the loop.
				if (created && !isGatewayEvent) {
					await notifyTemperatureAlert({
						sensorId: sensor.thingName, sensorName: sensor.name,
						alertType: 'lost_connection',
						equipmentId, equipmentName: eq?.name ?? sensor.name, timestamp: now
					});
				}
				results.push({
					sensorId: sensor.thingName,
					sensorName: sensor.name,
					temperature: null,
					humidity: null,
					equipmentId,
					alerts: ['no_reading']
				});
				continue;
			}

			const temperature = sample.data.tm != null ? rawToC(sample.data.tm) : null;
			const humidity = sample.data.hm != null ? rawToHumidity(sample.data.hm) : null;
			const timestamp = new Date(sample.time * 1000);

			await TemperatureReading.create({
				_id: generateId(),
				sensorId: sensor.thingName,
				sensorName: sensor.name,
				temperature,
				humidity,
				rawTemp: sample.data.tm ?? null,
				rawHumidity: sample.data.hm ?? null,
				timestamp,
				equipmentId
			});

			if (equipmentId && temperature != null) {
				await Equipment.findByIdAndUpdate(equipmentId, {
					currentTemperatureC: temperature,
					lastTemperatureReadAt: timestamp
				});
			}

			const sc = sensorConfigMap.get(sensor.thingName);
			const alertsEnabled = sc?.alertsEnabled ?? true;
			const minC = sc?.temperatureMinC ?? eq?.temperatureMinC ?? null;
			const maxC = sc?.temperatureMaxC ?? eq?.temperatureMaxC ?? null;
			const eqName = eq?.name ?? sc?.sensorName ?? sensor.name;

			// Visibility: surface unprotected sensors in logs so a missing
			// configuration is visible to anyone tailing the cron output.
			// (Won't spam — fires once per sensor per sync, ~12/hr at most.)
			if (alertsEnabled && temperature != null && minC == null && maxC == null) {
				console.warn(`[MOCREO SYNC] sensor "${eqName}" (${sensor.thingName}) has NO temperature thresholds — high/low alerts will never fire`);
			}

			if (alertsEnabled && temperature != null) {
				if (minC != null && temperature < minC) {
					await TemperatureAlert.create({
						_id: generateId(),
						sensorId: sensor.thingName,
						sensorName: sensor.name,
						alertType: 'low_temp',
						threshold: minC,
						actualValue: temperature,
						equipmentId,
						equipmentName: eqName,
						timestamp: now
					});
					alertsCreated.push('low_temp');
					await notifyTemperatureAlert({
						sensorId: sensor.thingName, sensorName: sensor.name,
						alertType: 'low_temp', threshold: minC, actualValue: temperature,
						equipmentId, equipmentName: eqName, timestamp: now
					});
				}
				if (maxC != null && temperature > maxC) {
					await TemperatureAlert.create({
						_id: generateId(),
						sensorId: sensor.thingName,
						sensorName: sensor.name,
						alertType: 'high_temp',
						threshold: maxC,
						actualValue: temperature,
						equipmentId,
						equipmentName: eqName,
						timestamp: now
					});
					alertsCreated.push('high_temp');
					await notifyTemperatureAlert({
						sensorId: sensor.thingName, sensorName: sensor.name,
						alertType: 'high_temp', threshold: maxC, actualValue: temperature,
						equipmentId, equipmentName: eqName, timestamp: now
					});
				}
			}

			if (now.getTime() - timestamp.getTime() > OFFLINE_THRESHOLD_MS) {
				const created = await checkLostConnection(sensor.thingName, sensor.name, eq, now, isGatewayEvent);
				alertsCreated.push('lost_connection');
				// Suppress per-sensor email when the whole gateway is out — a
				// single consolidated email is sent after the loop.
				if (created && !isGatewayEvent) {
					await notifyTemperatureAlert({
						sensorId: sensor.thingName, sensorName: sensor.name,
						alertType: 'lost_connection',
						equipmentId, equipmentName: eqName, timestamp: now
					});
				}
			}

			results.push({
				sensorId: sensor.thingName,
				sensorName: sensor.name,
				temperature,
				humidity,
				equipmentId,
				alerts: alertsCreated
			});
		} catch (err: any) {
			const message = err?.message ?? String(err);
			console.error(`[MOCREO SYNC] Error reading sensor ${sensor.thingName}:`, err);
			results.push({
				sensorId: sensor.thingName,
				sensorName: sensor.name,
				temperature: null,
				humidity: null,
				equipmentId,
				alerts: ['error'],
				error: message
			});
		}
	}

	const errored = results.filter((r) => r.error).length;
	const noReading = results.filter((r) => r.alerts.includes('no_reading')).length;
	console.log(`[MOCREO SYNC] done path=${path} sensors=${sensors.length} errors=${errored} noReading=${noReading} gatewayEvent=${isGatewayEvent}`);

	// Gateway-wide outage: emit ONE consolidated alert + email instead of N
	// per-sensor lost_connection notifications. Idempotent — only one unacked
	// gateway_outage alert at a time.
	if (isGatewayEvent) {
		const existing = await TemperatureAlert.findOne({
			alertType: 'gateway_outage',
			acknowledged: false
		});
		if (!existing) {
			await TemperatureAlert.create({
				_id: generateId(),
				sensorId: 'gateway',
				sensorName: 'Mocreo Gateway',
				alertType: 'gateway_outage',
				threshold: null,
				actualValue: null,
				equipmentId: null,
				equipmentName: 'Mocreo Gateway',
				timestamp: now,
				gatewayEvent: true,
				affectedSensorIds: silentSensors.map((s) => s.thingName)
			});
			await notifyGatewayOutage({
				timestamp: now,
				totalSensors: sensors.length,
				silentSensors: silentSensors.map((s) => ({
					sensorId: s.thingName,
					sensorName: s.name,
					equipmentName: sensorToEquipment.get(s.thingName)?.name ?? null
				}))
			});
		}
	}

	return json({
		success: true,
		syncedAt: now.toISOString(),
		sensorCount: sensors.length,
		errored,
		noReading,
		gatewayEvent: isGatewayEvent,
		silentSensorCount: silentSensors.length,
		results
	});
}
