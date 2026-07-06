import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { updatePhotoTruth } from '$lib/server/cv/photo-truth.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';

/**
 * PATCH /api/cv/images/[id]/tags
 *
 * Partial-updates a photo's defect labels / notes on the cartridge record
 * (photos[].labels / photos[].notes) — [id] is the photos[].imageId. labels
 * is select-only (picked from FailureLabel); this endpoint does not create
 * new FailureLabel docs — that only happens via POST /api/cv/failure-labels.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const body = await request.json();
	const patch: Record<string, any> = {};
	if (Array.isArray(body.labels)) {
		patch.labels = body.labels.filter((l: unknown) => typeof l === 'string');
	}
	if (typeof body.notes === 'string') {
		patch.notes = body.notes;
	}
	if (Object.keys(patch).length === 0) {
		return json({ error: 'labels (string[]) and/or notes (string) required' }, { status: 400 });
	}

	const updated = await updatePhotoTruth(params.id, patch);
	if (!updated) return json({ error: 'Photo not found' }, { status: 404 });

	await AuditLog.create({
		_id: generateId(),
		tableName: 'cartridge_records',
		recordId: updated.cartridgeRecordId,
		action: 'photo_qc_tags',
		newData: { imageId: params.id, ...patch },
		changedAt: new Date(),
		changedBy: locals.user.username
	});

	return json({ success: true });
};
