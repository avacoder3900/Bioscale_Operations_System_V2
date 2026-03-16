import { json } from '@sveltejs/kit';
import { pollInspection } from '$lib/server/cv-api';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	try {
		const result = await pollInspection(params.id);
		return json(result);
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'Poll failed';
		return json({ error: msg }, { status: 500 });
	}
};
