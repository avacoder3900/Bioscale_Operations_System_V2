import { json } from '@sveltejs/kit';
import { tagImage } from '$lib/server/cv-api';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { cartridge_record_id, phase, labels, notes } = body;

	if (!cartridge_record_id || !phase) {
		return json({ error: 'cartridge_record_id and phase are required' }, { status: 400 });
	}

	try {
		const result = await tagImage(params.id, {
			cartridge_record_id,
			phase,
			labels: labels ?? [],
			notes: notes ?? ''
		});
		return json(result);
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'Tag failed';
		return json({ error: msg }, { status: 500 });
	}
};
