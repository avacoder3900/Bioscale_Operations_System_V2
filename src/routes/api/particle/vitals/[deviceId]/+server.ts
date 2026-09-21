import { json } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import { getLastVitals } from '$lib/server/particle';
import type { RequestHandler } from './$types';

// Last known device vitals for the SPU detail page's Particle panel (SPU-INV-05).
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user || !hasPermission(locals.user, 'spu:read')) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const vitals = await getLastVitals(params.deviceId);
		return json(vitals);
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : 'Particle API unavailable' },
			{ status: 502 }
		);
	}
};
