import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, Spu } from '$lib/server/db';
import { readAndStoreIfNew } from '$lib/server/particle-validation';

/**
 * GET /api/validation/poll/[spuId]
 * Called by client-side polling (every 5 seconds) to check for new test data.
 * Uses session auth (cookie) — called from browser.
 *
 * Returns:
 *   { newSession: false } — no new data
 *   { newSession: true, sessionId, passed } — new session created
 *   { error: string } — failure
 */
export const GET: RequestHandler = async (event) => {
	// Require authenticated session
	if (!event.locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	await connectDB();

	const { spuId } = event.params;

	// Find SPU and get particleDeviceId
	const spu = await Spu.findById(spuId, {
		'particleLink.particleDeviceId': 1
	}).lean() as any;

	if (!spu) {
		return json({ error: 'SPU not found' }, { status: 404 });
	}

	if (!spu.particleLink?.particleDeviceId) {
		return json({ error: 'No Particle device linked to this SPU' }, { status: 400 });
	}

	const result = await readAndStoreIfNew(spuId, spu.particleLink.particleDeviceId);

	if (result.error) {
		return json({ newSession: false, error: result.error }, { status: 500 });
	}

	if (result.newSession) {
		return json({
			newSession: true,
			sessionId: result.sessionId,
			passed: result.passed
		});
	}

	return json({ newSession: false });
};
