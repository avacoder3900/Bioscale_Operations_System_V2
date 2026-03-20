import { json } from '@sveltejs/kit';
import { cvFetch } from '$lib/server/cv-api';
import type { RequestHandler } from './$types';
import type { InspectionResponse } from '$lib/types/cv';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const inspection = await cvFetch<InspectionResponse>(
			`/api/inspections/${params.id}/poll`
		);
		return json(inspection);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Poll failed';
		return json({ error: message }, { status: 502 });
	}
};
