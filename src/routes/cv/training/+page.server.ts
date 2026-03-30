import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const projects = await CvProject.find().sort({ createdAt: -1 }).lean();

	// Get label stats per project
	const stats = await CvImage.aggregate([
		{ $group: { _id: { projectId: '$projectId', label: '$label' }, count: { $sum: 1 } } }
	]);

	const projectStats: Record<string, { approved: number; rejected: number; unlabeled: number }> = {};
	for (const s of stats) {
		const pid = s._id.projectId;
		if (!projectStats[pid]) projectStats[pid] = { approved: 0, rejected: 0, unlabeled: 0 };
		if (s._id.label === 'approved') projectStats[pid].approved = s.count;
		else if (s._id.label === 'rejected') projectStats[pid].rejected = s.count;
		else projectStats[pid].unlabeled = s.count;
	}

	return {
		projects: JSON.parse(JSON.stringify(projects)),
		projectStats
	};
};

export const config = { maxDuration: 60 };
