import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const label = url.searchParams.get('label');
	const filter: Record<string, unknown> = { projectId: params.id };
	if (label === 'approved' || label === 'rejected') filter.label = label;
	else if (label === 'unlabeled') filter.label = null;

	const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
	const skip = parseInt(url.searchParams.get('skip') || '0');

	const [images, total] = await Promise.all([
		CvImage.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
		CvImage.countDocuments(filter)
	]);

	return json({ data: JSON.parse(JSON.stringify(images)), total });
};
