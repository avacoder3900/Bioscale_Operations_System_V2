import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const projectType = url.searchParams.get('projectType');
	const filter: Record<string, unknown> = {};
	if (projectType) filter.projectType = projectType;

	const projects = await CvProject.find(filter).sort({ createdAt: -1 }).lean();
	return json({ data: JSON.parse(JSON.stringify(projects)) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	try {
		const body = await request.json();
		if (!body.name) return json({ error: 'name is required' }, { status: 400 });

		const project = await CvProject.create({
			_id: generateId(),
			name: body.name,
			description: body.description,
			projectType: body.projectType,
			tags: body.tags || [],
			phases: body.phases || [],
			labels: body.labels || []
		});

		return json({ data: JSON.parse(JSON.stringify(project)) }, { status: 201 });
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};
