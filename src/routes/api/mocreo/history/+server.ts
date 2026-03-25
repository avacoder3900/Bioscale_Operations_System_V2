import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, TemperatureReading } from '$lib/server/db';

export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const sensorId = url.searchParams.get('sensorId');
	const equipmentId = url.searchParams.get('equipmentId');
	const period = url.searchParams.get('period') ?? '24h';

	if (!sensorId && !equipmentId) {
		return json({ error: 'sensorId or equipmentId required' }, { status: 400 });
	}

	const now = Date.now();
	const periodMs = period === '7d' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
	const since = new Date(now - periodMs);

	const filter: Record<string, any> = { timestamp: { $gte: since } };
	if (sensorId) filter.sensorId = sensorId;
	else if (equipmentId) filter.equipmentId = equipmentId;

	const readings = await TemperatureReading.find(filter)
		.sort({ timestamp: 1 })
		.select('sensorId sensorName temperature humidity timestamp')
		.lean();

	return json({
		period,
		count: readings.length,
		readings: JSON.parse(JSON.stringify(readings))
	});
};
