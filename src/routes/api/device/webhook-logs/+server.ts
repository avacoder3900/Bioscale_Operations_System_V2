import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, WebhookLog } from '$lib/server/db';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();

	await WebhookLog.create({
		deviceId: body.deviceId,
		eventName: body.eventName,
		timestamp: new Date(),
		processingTimeMs: body.processingTimeMs || null,
		request: body.request || {},
		response: body.response || {},
		cartridgeId: body.cartridgeId || null,
		assayId: body.assayId || null,
		firmwareVersion: body.firmwareVersion || null
	});

	return json({ success: true });
};
