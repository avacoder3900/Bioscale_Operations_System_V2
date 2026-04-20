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
import { notifyTemperatureAlert } from '$lib/server/notifications';

const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

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

async function checkLostConnection(sensorId: string, sensorName: string, eq: any, now: Date): Promise<boolean> {
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
		timestamp: now
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

	for (const sensor of sensors) {
		const alertsCreated: string[] = [];
		const eq = sensorToEquipment.get(sensor.thingName);
		const equipmentId = eq ? String(eq._id) : null;

		try {
			const sample = await fetchLatestReading(sensor.thingName);
			if (!sample) {
				const created = await checkLostConnection(sensor.thingName, sensor.name, eq, now);
				if (created) {
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
				const created = await checkLostConnection(sensor.thingName, sensor.name, eq, now);
				alertsCreated.push('lost_connection');
				if (created) {
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
	console.log(`[MOCREO SYNC] done path=${path} sensors=${sensors.length} errors=${errored} noReading=${noReading}`);

	return json({
		success: true,
		syncedAt: now.toISOString(),
		sensorCount: sensors.length,
		errored,
		noReading,
		results
	});
}
