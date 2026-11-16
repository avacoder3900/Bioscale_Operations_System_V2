import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, DeviceLog } from '$lib/server/db';
import { reconcileMagnetometers } from '$lib/server/magnetometer-identity-fill';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();

	const deviceLog = await DeviceLog.create({
		deviceId: body.deviceId,
		deviceName: body.deviceName || null,
		sessionId: body.sessionId,
		firmwareVersion: body.firmwareVersion || null,
		dataFormatVersion: body.dataFormatVersion || null,
		bootCount: body.bootCount || null,
		bootTime: body.bootTime ? new Date(body.bootTime) : new Date(),
		uploadedAt: new Date(),
		logLines: body.logLines || [],
		lineCount: body.lineCount || 0,
		errorCount: body.errorCount || 0,
		hasCrash: body.hasCrash || false,
		firstLine: body.firstLine || '',
		lastLine: body.lastLine || ''
	});

	// The log names the magnetometer the unit scanned; a sweep or mag test stored
	// before this upload may be waiting on exactly that. Best-effort, cannot throw.
	if (body.deviceId) await reconcileMagnetometers({ deviceId: String(body.deviceId) });

	return json({ success: true, logId: deviceLog._id });
};
