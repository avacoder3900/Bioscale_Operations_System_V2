import { json } from '@sveltejs/kit';
import { captureAndInspect } from '$lib/server/cv-api';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { sample_id, camera_index, inspection_type, metadata } = body;

	if (!sample_id) {
		return json({ error: 'sample_id is required' }, { status: 400 });
	}

	try {
		const result = await captureAndInspect(sample_id, {
			camera_index: camera_index ?? 0,
			inspection_type: inspection_type ?? 'anomaly_detection',
			metadata
		});
		return json(result, { status: 201 });
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'Capture failed';
		const status = msg.includes('502') ? 502 : msg.includes('404') ? 404 : 500;
		return json({ error: msg }, { status });
	}
};
