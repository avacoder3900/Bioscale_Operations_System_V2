import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, TemperatureAlert } from '$lib/server/db';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { alertId, userId, username } = body;

	if (!alertId) {
		return json({ error: 'alertId is required' }, { status: 400 });
	}

	const alert = await TemperatureAlert.findByIdAndUpdate(
		alertId,
		{
			acknowledged: true,
			acknowledgedBy: { _id: userId ?? 'system', username: username ?? 'system' },
			acknowledgedAt: new Date()
		},
		{ new: true }
	).lean();

	if (!alert) {
		return json({ error: 'Alert not found' }, { status: 404 });
	}

	return json({ success: true, alert: JSON.parse(JSON.stringify(alert)) });
};
