import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, generateId, Equipment, TemperatureReading } from '$lib/server/db';
import {
	fetchAllSensors,
	fetchLatestReading,
	rawToC,
	rawToHumidity
} from '$lib/server/services/mocreo';

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

	// Build sensor→equipment mapping
	const equipmentDocs = await Equipment.find({ mocreoDeviceId: { $ne: null } })
		.select('_id mocreoDeviceId')
		.lean() as any[];
	const sensorToEquipment = new Map<string, string>();
	for (const eq of equipmentDocs) {
		if (eq.mocreoDeviceId) sensorToEquipment.set(eq.mocreoDeviceId, String(eq._id));
	}

	// Fetch latest reading for each sensor (sequentially to respect rate limits)
	for (const sensor of sensors) {
		try {
			const sample = await fetchLatestReading(sensor.thingName);
			if (!sample) {
				results.push({
					sensorId: sensor.thingName,
					sensorName: sensor.name,
					temperature: null,
					humidity: null,
					equipmentId: sensorToEquipment.get(sensor.thingName) ?? null
				});
				continue;
			}

			const temperature = sample.data.tm != null ? rawToC(sample.data.tm) : null;
			const humidity = sample.data.hm != null ? rawToHumidity(sample.data.hm) : null;
			const timestamp = new Date(sample.time * 1000);
			const equipmentId = sensorToEquipment.get(sensor.thingName) ?? null;

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
				equipmentId: sensorToEquipment.get(sensor.thingName) ?? null
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
