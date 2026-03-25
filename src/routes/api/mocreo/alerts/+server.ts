import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, TemperatureAlert } from '$lib/server/db';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const alerts = await TemperatureAlert.find({ acknowledged: false })
		.sort({ timestamp: -1 })
		.lean();

	return json({
		success: true,
		count: alerts.length,
		alerts: JSON.parse(JSON.stringify(alerts))
	});
};
