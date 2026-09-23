import { json } from '@sveltejs/kit';

export const config = {
	maxDuration: 60
};
import { ingestMagnetValidation } from '$lib/server/magnetometer-ingest';
import type { RequestHandler } from './$types';

/**
 * Poll the magnet_validation variable on a Particle device.
 * If the data has changed since the last known hash, save a new ValidationSession.
 *
 * The read-and-store body lives in $lib/server/magnetometer-ingest so the
 * API-key sweep can reuse it instead of carrying a second copy.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const { spuId, spuUdi, particleDeviceId, lastHash, seedOnly } = await request.json();

	if (!particleDeviceId) {
		return json({ error: 'No Particle device ID' }, { status: 400 });
	}

	const result = await ingestMagnetValidation({
		spuId,
		spuUdi,
		particleDeviceId,
		lastHash,
		seedOnly,
		actor: { _id: locals.user._id, username: locals.user.username },
		source: 'auto-poll'
	});

	return json(result, result.status === 'error' ? { status: 500 } : undefined);
};
