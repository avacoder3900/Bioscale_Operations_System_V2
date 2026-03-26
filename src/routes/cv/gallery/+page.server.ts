import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const projectId = url.searchParams.get('projectId');
	const label = url.searchParams.get('label');
	const page = parseInt(url.searchParams.get('page') || '1');
	const limit = 48;
	const skip = (page - 1) * limit;

	const filter: Record<string, unknown> = {};
	if (projectId) filter.projectId = projectId;
	if (label === 'approved' || label === 'rejected') filter.label = label;
	else if (label === 'unlabeled') filter.label = null;

	const [images, total, projects] = await Promise.all([
		CvImage.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
		CvImage.countDocuments(filter),
		CvProject.find().select('_id name').sort({ name: 1 }).lean()
	]);

	return {
		images: JSON.parse(JSON.stringify(images)),
		projects: JSON.parse(JSON.stringify(projects)),
		total,
		page,
		totalPages: Math.ceil(total / limit),
		filters: { projectId: projectId || '', label: label || '' }
	};
};

export const config = { maxDuration: 60 };
