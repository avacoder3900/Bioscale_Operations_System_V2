import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, Equipment } from '$lib/server/db';
import { fetchAllSensors, fetchLatestReading, rawToC, rawToHumidity } from '$lib/server/services/mocreo';

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const [sensors, equipmentDocs] = await Promise.all([
		fetchAllSensors(),
		Equipment.find({ mocreoDeviceId: { $ne: null } })
			.select('_id name mocreoDeviceId equipmentType')
			.lean() as Promise<any[]>
	]);

	const sensorToEquipment = new Map<string, any>();
	for (const eq of equipmentDocs) {
		if (eq.mocreoDeviceId) {
			sensorToEquipment.set(eq.mocreoDeviceId, {
				equipmentId: String(eq._id),
				equipmentName: eq.name,
				equipmentType: eq.equipmentType
			});
		}
	}

	const result = await Promise.all(
		sensors.map(async (sensor) => {
			let temperature: number | null = null;
			let humidity: number | null = null;
			let readingTime: string | null = null;

			try {
				const sample = await fetchLatestReading(sensor.thingName);
				if (sample) {
					temperature = sample.data.tm != null ? rawToC(sample.data.tm) : null;
					humidity = sample.data.hm != null ? rawToHumidity(sample.data.hm) : null;
					readingTime = new Date(sample.time * 1000).toISOString();
				}
			} catch {
				// sensor offline or API error
			}

			const mapping = sensorToEquipment.get(sensor.thingName) ?? null;

			return {
				sensorId: sensor.thingName,
				sensorName: sensor.name,
				model: sensor.model,
				temperature,
				humidity,
				readingTime,
				equipment: mapping
			};
		})
	);

	return json({ sensors: result });
};
