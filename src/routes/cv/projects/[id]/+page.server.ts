import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const project = await CvProject.findById(params.id).lean();
	if (!project) redirect(302, '/cv');

	const [images, recentInspections, labelStats] = await Promise.all([
		CvImage.find({ projectId: params.id })
			.sort({ createdAt: -1 })
			.limit(100)
			.lean(),
		CvInspection.find({ projectId: params.id })
			.sort({ createdAt: -1 })
			.limit(20)
			.lean(),
		CvImage.aggregate([
			{ $match: { projectId: params.id } },
			{ $group: { _id: '$label', count: { $sum: 1 } } }
		])
	]);

	const stats = {
		approved: 0,
		rejected: 0,
		unlabeled: 0
	};
	for (const s of labelStats) {
		if (s._id === 'approved') stats.approved = s.count;
		else if (s._id === 'rejected') stats.rejected = s.count;
		else stats.unlabeled = s.count;
	}

	return {
		project: JSON.parse(JSON.stringify(project)),
		images: JSON.parse(JSON.stringify(images)),
		inspections: JSON.parse(JSON.stringify(recentInspections)),
		labelStats: stats
	};
};

export const config = { maxDuration: 60 };
