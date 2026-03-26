import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	try {
		const body = await request.json();
		const { label } = body;
		if (label !== 'approved' && label !== 'rejected' && label !== null) {
			return json({ error: 'label must be "approved", "rejected", or null' }, { status: 400 });
		}

		const image = await CvImage.findById(params.id).lean() as any;
		if (!image) return json({ error: 'Image not found' }, { status: 404 });

		const oldLabel = image.label;
		await CvImage.findByIdAndUpdate(params.id, { label });

		// Update annotatedCount on project
		const wasLabeled = oldLabel === 'approved' || oldLabel === 'rejected';
		const isLabeled = label === 'approved' || label === 'rejected';

		if (!wasLabeled && isLabeled) {
			await CvProject.findByIdAndUpdate(image.projectId, { $inc: { annotatedCount: 1 } });
		} else if (wasLabeled && !isLabeled) {
			await CvProject.findByIdAndUpdate(image.projectId, { $inc: { annotatedCount: -1 } });
		}

		return json({ success: true, label });
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};
