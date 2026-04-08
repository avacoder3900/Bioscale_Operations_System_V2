import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const filterResult = url.searchParams.get('result') || '';
	const filterProject = url.searchParams.get('projectId') || '';
	const filterCartridge = url.searchParams.get('cartridge') || '';
	const pageNum = parseInt(url.searchParams.get('page') || '1');
	const pageSize = 20;

	const filter: Record<string, unknown> = {};
	if (filterResult) filter.result = filterResult;
	if (filterProject) filter.projectId = filterProject;
	if (filterCartridge) filter.cartridgeRecordId = { $regex: filterCartridge, $options: 'i' };

	const [inspections, total, projects] = await Promise.all([
		CvInspection.find(filter)
			.sort({ createdAt: -1 })
			.skip((pageNum - 1) * pageSize)
			.limit(pageSize)
			.lean(),
		CvInspection.countDocuments(filter),
		CvProject.find().select('_id name').sort({ name: 1 }).lean()
	]);

	// Build project name lookup
	const projectMap: Record<string, string> = {};
	for (const p of projects as any[]) {
		projectMap[p._id] = p.name;
	}

	return {
		inspections: JSON.parse(JSON.stringify(inspections)),
		projects: JSON.parse(JSON.stringify(projects)),
		projectMap,
		filters: { result: filterResult, projectId: filterProject, cartridge: filterCartridge },
		pagination: { page: pageNum, totalPages: Math.max(1, Math.ceil(total / pageSize)), total }
	};
};

export const config = { maxDuration: 60 };
