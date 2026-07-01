import { json, error } from '@sveltejs/kit';
import { cvFetch } from '$lib/server/cv-api';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import type { RequestHandler } from './$types';
import type { ImageResponse } from '$lib/types/cv';

/**
 * PATCH /api/cv/images/[id]/tags
 *
 * Partial-updates cartridgeTag.labels / cartridgeTag.notes directly on the
 * Mongo CvImage doc (unlike the POST below, which proxies to an external CV
 * worker — that path is currently unused by any caller). labels is
 * select-only (picked from FailureLabel); this endpoint does not create new
 * FailureLabel docs — that only happens via POST /api/cv/failure-labels.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const body = await request.json();
	const update: Record<string, any> = {};
	if (Array.isArray(body.labels)) {
		update['cartridgeTag.labels'] = body.labels.filter((l: unknown) => typeof l === 'string');
	}
	if (typeof body.notes === 'string') {
		update['cartridgeTag.notes'] = body.notes;
	}
	if (Object.keys(update).length === 0) {
		return json({ error: 'labels (string[]) and/or notes (string) required' }, { status: 400 });
	}

	const image = await CvImage.findById(params.id);
	if (!image) return json({ error: 'Image not found' }, { status: 404 });

	await CvImage.updateOne({ _id: params.id }, { $set: update });

	return json({ success: true });
};

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
