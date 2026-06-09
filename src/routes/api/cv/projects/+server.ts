/**
 * GET  /api/cv/projects — list all projects with summary stats.
 * POST /api/cv/projects — create a new project (training set).
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const projects = await CvProject.find().sort({ createdAt: -1 }).lean();
	return json({ data: JSON.parse(JSON.stringify(projects)) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const body = await request.json();
	if (!body.name) return json({ error: 'name is required' }, { status: 400 });

	const project = await CvProject.create({
		_id: generateId(),
		name: body.name,
		description: body.description ?? '',
		purpose: body.purpose ?? '',
		tags: body.tags ?? [],
		members: body.members ?? [],
		composedOf: body.composedOf ?? [],
		isLiveComposition: !!body.isLiveComposition,
		deployAtPhases: body.deployAtPhases ?? [],
		trainedModels: [],
		activeModelVersion: null,
		shadowModelVersion: null
	});

	return json({ data: JSON.parse(JSON.stringify(project)) }, { status: 201 });
};
