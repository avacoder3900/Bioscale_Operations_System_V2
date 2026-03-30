import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvSample } from '$lib/server/db/models/cv-sample.js';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const projectId = url.searchParams.get('projectId');
	const filter: Record<string, unknown> = {};
	if (projectId) filter.projectId = projectId;

	const samples = await CvSample.find(filter).sort({ createdAt: -1 }).lean();
	return json({ data: JSON.parse(JSON.stringify(samples)) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	try {
		const body = await request.json();
		if (!body.name) return json({ error: 'name is required' }, { status: 400 });

		const sample = await CvSample.create({
			_id: generateId(),
			name: body.name,
			description: body.description,
			projectId: body.projectId,
			tags: body.tags || [],
			metadata: body.metadata
		});

		return json({ data: JSON.parse(JSON.stringify(sample)) }, { status: 201 });
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};
