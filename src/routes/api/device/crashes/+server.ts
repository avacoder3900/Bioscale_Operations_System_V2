import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, DeviceCrash } from '$lib/server/db';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();

	const crash = await DeviceCrash.create({
		deviceId: body.deviceId,
		deviceName: body.deviceName || null,
		firmwareVersion: body.firmwareVersion || null,
		bootCount: body.bootCount || null,
		detectedAt: new Date(),
		lastCheckpoint: body.lastCheckpoint,
		lastCheckpointName: body.lastCheckpointName,
		checkpointSequence: body.checkpointSequence || [],
		crashCategory: body.crashCategory,
		sessionLogId: body.sessionLogId || null
	});

	return json({ success: true, crashId: crash._id });
};

export const GET: RequestHandler = async ({ url, locals }) => {
	requirePermission(locals.user, 'device:read');
	await connectDB();

	const deviceId = url.searchParams.get('deviceId');
	const category = url.searchParams.get('category');
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	const page = parseInt(url.searchParams.get('page') || '1');
	const limit = parseInt(url.searchParams.get('limit') || '50');

	const filter: Record<string, any> = {};
	if (deviceId) filter.deviceId = deviceId;
	if (category) filter.crashCategory = category;
	if (from || to) {
		filter.detectedAt = {} as Record<string, Date>;
		if (from) filter.detectedAt.$gte = new Date(from);
		if (to) filter.detectedAt.$lte = new Date(to);
	}

	const [crashes, total] = await Promise.all([
		DeviceCrash.find(filter)
			.sort({ detectedAt: -1 })
			.skip((page - 1) * limit)
			.limit(limit)
			.lean(),
		DeviceCrash.countDocuments(filter)
	]);

	return json({
		crashes: JSON.parse(JSON.stringify(crashes)),
		total,
		page
	});
};
