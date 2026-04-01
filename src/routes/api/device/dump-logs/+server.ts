import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { callFunction } from '$lib/server/particle';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	requirePermission(locals.user, 'device:write');
	await connectDB();

	const body = await request.json();
	const { particleDeviceId } = body;

	if (!particleDeviceId) {
		throw error(400, 'particleDeviceId is required');
	}

	try {
		const result = await callFunction(particleDeviceId, 'upload_log', '');
		// result.return_value: 1 = queued, 0 = no log data, -1 = help shown
		return json({
			success: result.return_value === 1,
			returnValue: result.return_value,
			message: result.return_value === 1
				? 'Log upload triggered on device'
				: result.return_value === 0
					? 'No log data on device to upload'
					: 'Unexpected response from device'
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return json(
			{ success: false, error: message },
			{ status: 502 }
		);
	}
};
