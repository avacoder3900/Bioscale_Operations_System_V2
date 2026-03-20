import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, Equipment, EquipmentLocation } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const [equipment, locations] = await Promise.all([
		Equipment.find().lean(),
		EquipmentLocation.find().select('_id displayName locationType isActive').lean()
	]);

	let active = 0, maintenance = 0, offline = 0;
	const mapped = (equipment as any[]).map(e => {
		if (e.status === 'active') active++;
		else if (e.status === 'maintenance') maintenance++;
		else if (e.status === 'offline') offline++;
		return {
			id: e._id,
			name: e.name,
			type: e.equipmentType,
			location: e.location,
			status: e.status,
			temperatureC: e.currentTemperatureC,
			lastReadAt: e.lastTemperatureReadAt
		};
	});

	return json({
		success: true,
		data: {
			equipment: mapped,
			locations: (locations as any[]).map(l => ({ id: l._id, name: l.displayName, type: l.locationType, isActive: l.isActive })),
			summary: { total: mapped.length, active, maintenance, offline }
		}
	});
};
