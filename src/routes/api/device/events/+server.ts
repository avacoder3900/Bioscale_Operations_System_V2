import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, DeviceEvent, generateId } from '$lib/server/db';
import { retryMonitorFlagIfPending } from '$lib/server/service-flag';
import { runAfterResponse } from '$lib/server/after-response';

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

	// This is the route the Lambda reports upload-test / device-log on, so it is where a
	// monitor-flag push that timed out mid-test gets its retry: the device is connected now.
	if (body.deviceId && body.eventName) {
		runAfterResponse(retryMonitorFlagIfPending(String(body.deviceId), String(body.eventName)));
	}

	return json({ success: true });
};
