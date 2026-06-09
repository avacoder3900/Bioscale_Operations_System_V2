/**
 * In-app trigger enqueue.
 *
 * Browser → POST /api/scanner/trigger { deviceId, source?, contextRef? }
 * Authenticated by user session + manufacturing:write permission.
 *
 * Inserts a row into scanner_triggers; the daemon polls
 * /api/agent/scanner/triggers and consumes it.
 */
import { json, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ScannerTrigger } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	requirePermission(locals.user, 'manufacturing:write');

	let body: any;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
	if (!deviceId) throw error(400, 'deviceId is required');

	const source = ['test', 'wax_filling', 'reagent_filling', 'manual'].includes(body?.source)
		? body.source : 'test';

	await connectDB();
	const trigger = await ScannerTrigger.create({
		deviceId,
		source,
		contextRef: typeof body?.contextRef === 'string' ? body.contextRef : undefined,
		requestedBy: locals.user._id,
		requestedByUsername: locals.user.username,
		requestedAt: new Date()
	});

	return json({ success: true, triggerId: trigger._id });
};
