import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, DeviceEvent, generateId } from '$lib/server/db';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();

	await DeviceEvent.create({
		_id: generateId(),
		deviceId: body.deviceId,
		eventType: body.eventName,
		eventData: body.data || null,
		createdAt: body.publishedAt ? new Date(body.publishedAt) : new Date()
	});

	return json({ success: true });
};
