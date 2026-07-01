import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { FailureLabel } from '$lib/server/db/models/failure-label.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { requirePermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const label = await FailureLabel.findById(params.id).lean() as any;
	if (!label) return json({ error: 'Label not found' }, { status: 404 });

	// Deleting only removes it from the pick-list — photos already tagged with
	// this text keep the string in cartridgeTag.labels (not retroactively stripped).
	await FailureLabel.findByIdAndDelete(params.id);

	const inUseCount = await CvImage.countDocuments({ 'cartridgeTag.labels': label.text });

	return json({ success: true, inUseCount });
};
