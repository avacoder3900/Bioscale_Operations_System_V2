import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, TemperatureAlert } from '$lib/server/db';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { alertId } = body;

	if (!alertId) {
		return json({ error: 'alertId is required' }, { status: 400 });
	}

	const result = await TemperatureAlert.findByIdAndUpdate(alertId, {
		acknowledged: true,
		acknowledgedAt: new Date()
	}, { new: true });

	if (!result) {
		return json({ error: 'Alert not found' }, { status: 404 });
	}

	return json({ success: true, alert: JSON.parse(JSON.stringify(result)) });
};
