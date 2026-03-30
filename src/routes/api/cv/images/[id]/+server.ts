import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { deleteFromR2 } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const image = await CvImage.findById(params.id).lean();
	if (!image) return json({ error: 'Image not found' }, { status: 404 });

	return json({ data: JSON.parse(JSON.stringify(image)) });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	try {
		const image = await CvImage.findById(params.id).lean() as any;
		if (!image) return json({ error: 'Image not found' }, { status: 404 });

		// Delete from R2
		try {
			if (image.filePath) await deleteFromR2(image.filePath);
			if (image.thumbnailPath) await deleteFromR2(image.thumbnailPath);
		} catch { /* best effort */ }

		await CvImage.findByIdAndDelete(params.id);

		// Decrement project counts
		const dec: Record<string, number> = { imageCount: -1 };
		if (image.label === 'approved' || image.label === 'rejected') {
			dec.annotatedCount = -1;
		}
		await CvProject.findByIdAndUpdate(image.projectId, { $inc: dec });

		return json({ success: true });
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};
