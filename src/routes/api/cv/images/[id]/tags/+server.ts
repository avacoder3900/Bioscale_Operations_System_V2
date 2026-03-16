import { json } from '@sveltejs/kit';
import { cvFetch } from '$lib/server/cv-api';
import type { RequestHandler } from './$types';
import type { ImageResponse } from '$lib/types/cv';

export const POST: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = await request.json();
	const { cartridge_record_id, phase, labels, notes } = body;

	if (!cartridge_record_id) {
		return json({ error: 'cartridge_record_id is required' }, { status: 400 });
	}

	try {
		const result = await cvFetch<ImageResponse>(
			`/api/v1/images/${params.id}/tags`,
			{
				method: 'POST',
				body: {
					cartridge_record_id,
					phase: phase || '',
					labels: labels || [],
					notes: notes || ''
				}
			}
		);
		return json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Tagging failed';
		return json({ error: message }, { status: 502 });
	}
};
