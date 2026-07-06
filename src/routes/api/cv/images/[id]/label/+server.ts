import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { updatePhotoTruth } from '$lib/server/cv/photo-truth.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';

/**
 * PATCH /api/cv/images/[id]/label
 *
 * Sets the human QC label (the CV training label) on a photo. Truth lives on
 * cartridge_records.photos[] — the [id] param is the photos[].imageId.
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

	const operator = { _id: locals.user._id, username: locals.user.username };
	const updated = await updatePhotoTruth(params.id, {
		qcLabel,
		qcLabeledBy: qcLabel ? operator : null,
		qcLabeledAt: qcLabel ? new Date() : null
	});
	if (!updated) return json({ error: 'Photo not found' }, { status: 404 });

	await AuditLog.create({
		_id: generateId(),
		tableName: 'cartridge_records',
		recordId: updated.cartridgeRecordId,
		action: 'photo_qc_label',
		newData: { imageId: params.id, qcLabel },
		changedAt: new Date(),
		changedBy: locals.user.username
	});

	return json({ success: true, qcLabel });
};
