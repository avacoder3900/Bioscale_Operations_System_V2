import { json } from '@sveltejs/kit';
import { cvFetch } from '$lib/server/cv-api';
import type { RequestHandler } from './$types';
import type { CaptureAndInspectResponse } from '$lib/types/cv';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = await request.json();
	const { sample_id, camera_index, inspection_type } = body;

	if (!sample_id) {
		return json({ error: 'sample_id is required' }, { status: 400 });
	}

	try {
		const result = await cvFetch<CaptureAndInspectResponse>(
			`/api/v1/samples/${sample_id}/capture-and-inspect`,
			{
				method: 'POST',
				body: {
					camera_index: camera_index ?? 0,
					inspection_type: inspection_type ?? 'anomaly_detection',
					metadata: {}
				}
			}
		);

		return json(result, { status: 201 });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Capture failed';
		return json({ error: message }, { status: 502 });
	}
};
