/**
 * Particle Cloud Webhook Handler
 *
 * Receives events from Particle Cloud webhooks and stores them as DeviceEvent records.
 * Particle webhooks send JSON POST payloads with event data.
 *
 * Configure in Particle Console:
 *   URL: https://<your-domain>/api/particle/webhook
 *   Request Type: POST
 *   Request Format: JSON
 */
import { json } from '@sveltejs/kit';
import { connectDB, DeviceEvent, ParticleDevice, generateId } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();

	// Particle webhook payload format:
	// { event: "event_name", data: "...", coreid: "device_id", published_at: "ISO string" }
	const {
		event: eventName,
		data: eventData,
		coreid: deviceId,
		published_at: publishedAt
	} = body;

	if (!deviceId) {
		return json({ error: 'Missing coreid (device ID)' }, { status: 400 });
	}

	// Map Particle event names to our event types
	const eventTypeMap: Record<string, string> = {
		'bioscale/validate': 'validate',
		'bioscale/load_assay': 'load_assay',
		'bioscale/upload': 'upload',
		'bioscale/reset': 'reset',
		'bioscale/error': 'error',
		validate: 'validate',
		load_assay: 'load_assay',
		upload: 'upload',
		reset: 'reset',
		error: 'error'
	};

	const eventType = eventTypeMap[eventName] ?? eventName;

	// Parse event data (may be JSON string or plain string)
	let parsedData: any = eventData;
	if (typeof eventData === 'string') {
		try {
			parsedData = JSON.parse(eventData);
		} catch {
			parsedData = { raw: eventData };
		}
	}

	// Create immutable device event
	await DeviceEvent.create({
		_id: generateId(),
		deviceId,
		eventType,
		eventData: parsedData,
		cartridgeUuid: parsedData?.cartridgeUuid ?? parsedData?.cartridge_uuid ?? null,
		success: parsedData?.success !== false && eventType !== 'error',
		errorMessage: parsedData?.error ?? parsedData?.errorMessage ?? null,
		createdAt: publishedAt ? new Date(publishedAt) : new Date()
	});

	// Update device last-heard timestamp
	await ParticleDevice.updateOne(
		{ particleDeviceId: deviceId },
		{
			$set: {
				lastHeardAt: publishedAt ? new Date(publishedAt) : new Date(),
				status: 'online'
			}
		}
	);

	return json({ success: true, event: eventType, deviceId });
};
