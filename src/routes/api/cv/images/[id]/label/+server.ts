import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import type { RequestHandler } from './$types';

/**
 * PATCH /api/cv/images/[id]/label
 *
 * Sets the qcLabel on an image. After the refactor, labels live on the image
 * directly — no project annotatedCount counters to maintain (projects derive
 * their stats from member queries).
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const body = await request.json();
	// Accept both `qcLabel` (new) and `label` (legacy callers).
	const qcLabel = body.qcLabel ?? body.label ?? null;

	if (qcLabel !== 'approved' && qcLabel !== 'rejected' && qcLabel !== null) {
		return json({ error: 'qcLabel must be "approved", "rejected", or null' }, { status: 400 });
	}

	const image = await CvImage.findById(params.id);
	if (!image) return json({ error: 'Image not found' }, { status: 404 });

	await CvImage.updateOne(
		{ _id: params.id },
		{ $set: {
			qcLabel,
			qcLabeledBy: qcLabel ? { _id: locals.user._id, username: locals.user.username } : null,
			qcLabeledAt: qcLabel ? new Date() : null
		}}
	);

	return json({ success: true, qcLabel });
};
