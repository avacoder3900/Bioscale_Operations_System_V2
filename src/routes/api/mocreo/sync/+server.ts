import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
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
	//    Bearer header is absent and our endpoint otherwise 401s — silent
	//    death. The endpoint is read-only from the operator's perspective
	//    (syncs upstream Mocreo readings into our DB); spoofed UA could
	//    trigger extra syncs but nothing destructive, and Mocreo's own rate
	//    limit caps abuse. GET only — POST still requires the agent key.
	if (request.method === 'GET') {
		const ua = request.headers.get('user-agent') ?? '';
		if (ua.startsWith('vercel-cron/')) return;
	}

	// 3) Fall back to agent API key auth (openclaw, worker scripts).
	requireAgentApiKey(request);
}

async function runSync(request: Request) {
	authenticateSync(request);
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
	const results: Array<{
		sensorId: string;
		sensorName: string;
		temperature: number | null;
		humidity: number | null;
		equipmentId: string | null;
		alerts: string[];
		error?: string;
	}> = [];

	// Build sensor→equipment mapping
	const equipmentDocs = await Equipment.find({ mocreoDeviceId: { $ne: null } })
		.select('_id mocreoDeviceId name temperatureMinC temperatureMaxC')
		.lean() as any[];
	const sensorToEquipment = new Map<string, any>();
	for (const eq of equipmentDocs) {
		if (eq.mocreoDeviceId) sensorToEquipment.set(eq.mocreoDeviceId, eq);
	}

	// Load sensor configs for threshold overrides
	const sensorConfigs = await SensorConfig.find().lean() as any[];
	const sensorConfigMap = new Map<string, any>();
	for (const sc of sensorConfigs) sensorConfigMap.set(sc._id, sc);

	const now = new Date();

	// Fetch latest reading for each sensor (sequentially to respect rate limits)
	for (const sensor of sensors) {
		const alertsCreated: string[] = [];
		const eq = sensorToEquipment.get(sensor.thingName);
		const equipmentId = eq ? String(eq._id) : null;

		try {
			const sample = await fetchLatestReading(sensor.thingName);
			if (!sample) {
				// No reading — check for lost connection
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

			// Store reading
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

			// Update equipment with latest temperature
			if (equipmentId && temperature != null) {
				await Equipment.findByIdAndUpdate(equipmentId, {
					currentTemperatureC: temperature,
					lastTemperatureReadAt: timestamp
				});
			}

			// Check thresholds after storing reading (SensorConfig overrides Equipment)
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

			// Check for lost connection (reading is old)
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

	return json({
		success: true,
		syncedAt: now.toISOString(),
		sensorCount: sensors.length,
		results
	});
}

// GET: called by Vercel Cron every 5 minutes
export const GET: RequestHandler = async ({ request }) => runSync(request);

// POST: called by worker scripts and the openclaw agent
export const POST: RequestHandler = async ({ request }) => runSync(request);

async function checkLostConnection(sensorId: string, sensorName: string, eq: any, now: Date): Promise<boolean> {
	// Only create if there isn't already an unacknowledged lost_connection alert for this sensor
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
