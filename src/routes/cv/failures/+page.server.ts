import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const failFilter = { result: 'fail' };

	const [
		totalFailures,
		totalInspections,
		byDefect,
		byProject,
		byPhase,
		recent,
		projects
	] = await Promise.all([
		CvInspection.countDocuments(failFilter),
		CvInspection.countDocuments({ result: { $in: ['pass', 'fail'] } }),
		// Most common defect types across failed inspections
		CvInspection.aggregate([
			{ $match: failFilter },
			{ $unwind: '$defects' },
			{
				$group: {
					_id: { $ifNull: ['$defects.type', 'Unspecified'] },
					count: { $sum: 1 }
				}
			},
			{ $sort: { count: -1 } },
			{ $limit: 15 }
		]),
		// Failures grouped by project
		CvInspection.aggregate([
			{ $match: failFilter },
			{ $group: { _id: '$projectId', count: { $sum: 1 } } },
			{ $sort: { count: -1 } },
			{ $limit: 15 }
		]),
		// Failures grouped by manufacturing phase
		CvInspection.aggregate([
			{ $match: failFilter },
			{
				$group: {
					_id: { $ifNull: ['$phase', 'Unspecified'] },
					count: { $sum: 1 }
				}
			},
			{ $sort: { count: -1 } }
		]),
		// Recent failed inspections
		CvInspection.find(failFilter)
			.sort({ createdAt: -1 })
			.limit(25)
			.select('projectId phase confidenceScore defects cartridgeRecordId inspectionType createdAt')
			.lean(),
		CvProject.find().select('_id name').lean()
	]);

	const projectMap: Record<string, string> = {};
	for (const p of projects as any[]) {
		projectMap[p._id] = p.name;
	}

	const failRate = totalInspections > 0 ? totalFailures / totalInspections : 0;

	return {
		totalFailures,
		totalInspections,
		failRate,
		byDefect: JSON.parse(JSON.stringify(byDefect)),
		byProject: JSON.parse(JSON.stringify(byProject)),
		byPhase: JSON.parse(JSON.stringify(byPhase)),
		recent: JSON.parse(JSON.stringify(recent)),
		projectMap
	};
};

export const config = { maxDuration: 60 };
