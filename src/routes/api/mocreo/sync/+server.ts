import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, generateId, Equipment, TemperatureReading, TemperatureAlert } from '$lib/server/db';
import {
	fetchAllSensors,
	fetchLatestReading,
	rawToC,
	rawToHumidity
} from '$lib/server/services/mocreo';

async function checkAlerts(
	sensorId: string,
	sensorName: string,
	equipmentId: string | null,
	temperature: number | null,
	readingTimestamp: Date,
	equipment: any
): Promise<void> {
	if (!equipmentId || !equipment?.alertsEnabled) return;

	// Check temperature thresholds
	if (temperature != null) {
		if (equipment.temperatureMaxC != null && temperature > equipment.temperatureMaxC) {
			await TemperatureAlert.create({
				_id: generateId(),
				sensorId,
				sensorName,
				equipmentId,
				alertType: 'high_temp',
				threshold: equipment.temperatureMaxC,
				actualValue: temperature,
				timestamp: readingTimestamp
			});
		}
		if (equipment.temperatureMinC != null && temperature < equipment.temperatureMinC) {
			await TemperatureAlert.create({
				_id: generateId(),
				sensorId,
				sensorName,
				equipmentId,
				alertType: 'low_temp',
				threshold: equipment.temperatureMinC,
				actualValue: temperature,
				timestamp: readingTimestamp
			});
		}
	}

	// Check lost connection
	const timeoutMs = (equipment.connectionTimeoutMinutes ?? 30) * 60 * 1000;
	if (Date.now() - readingTimestamp.getTime() > timeoutMs) {
		// Only create if no recent unacknowledged lost_connection alert exists
		const existing = await TemperatureAlert.findOne({
			sensorId,
			alertType: 'lost_connection',
			acknowledged: false
		}).lean();
		if (!existing) {
			await TemperatureAlert.create({
				_id: generateId(),
				sensorId,
				sensorName,
				equipmentId,
				alertType: 'lost_connection',
				threshold: equipment.connectionTimeoutMinutes ?? 30,
				actualValue: Math.round((Date.now() - readingTimestamp.getTime()) / 60000),
				timestamp: new Date()
			});
		}
	}
}

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const sensors = await fetchAllSensors();
	const results: Array<{
		sensorId: string;
		sensorName: string;
		temperature: number | null;
		humidity: number | null;
		equipmentId: string | null;
	}> = [];

	const equipmentDocs = await Equipment.find({ mocreoDeviceId: { $ne: null } })
		.select('_id mocreoDeviceId temperatureMinC temperatureMaxC alertsEnabled connectionTimeoutMinutes')
		.lean() as any[];
	const sensorToEquipment = new Map<string, any>();
	for (const eq of equipmentDocs) {
		if (eq.mocreoDeviceId) sensorToEquipment.set(eq.mocreoDeviceId, eq);
	}

	for (const sensor of sensors) {
		try {
			const sample = await fetchLatestReading(sensor.thingName);
			if (!sample) {
				results.push({
					sensorId: sensor.thingName,
					sensorName: sensor.name,
					temperature: null,
					humidity: null,
					equipmentId: sensorToEquipment.get(sensor.thingName)?._id ?? null
				});
				continue;
			}

			const temperature = sample.data.tm != null ? rawToC(sample.data.tm) : null;
			const humidity = sample.data.hm != null ? rawToHumidity(sample.data.hm) : null;
			const timestamp = new Date(sample.time * 1000);
			const eq = sensorToEquipment.get(sensor.thingName);
			const equipmentId = eq ? String(eq._id) : null;

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

			// Check for alerts
			await checkAlerts(sensor.thingName, sensor.name, equipmentId, temperature, timestamp, eq);

			results.push({
				sensorId: sensor.thingName,
				sensorName: sensor.name,
				temperature,
				humidity,
				equipmentId
			});
		} catch (err) {
			console.error(`[MOCREO SYNC] Error reading sensor ${sensor.thingName}:`, err);
			results.push({
				sensorId: sensor.thingName,
				sensorName: sensor.name,
				temperature: null,
				humidity: null,
				equipmentId: sensorToEquipment.get(sensor.thingName)?._id ?? null
			});
		}
	}

	return json({
		success: true,
		syncedAt: new Date().toISOString(),
		sensorCount: sensors.length,
		results
	});
};
