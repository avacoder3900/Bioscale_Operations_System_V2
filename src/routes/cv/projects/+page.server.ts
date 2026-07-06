/**
 * /cv/projects — list every CV project (one model per manufacturing concern).
 * Projects don't own photos: their scope is phases[], and their training set
 * derives from cartridge_records.photos[] labels at train time.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { generateId } from '$lib/server/db/utils.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const projectsRaw = await CvProject.find()
		.sort({ createdAt: -1 })
		.select('_id name description projectType phases modelStatus activeModelVersion shadowModelVersion trainedModels.version trainedModels.trainedAt trainedModels.holdoutAccuracy createdAt updatedAt')
		.lean();

	const projects = (projectsRaw as any[]).map(p => ({
		id: p._id,
		name: p.name ?? '',
		description: p.description ?? '',
		projectType: p.projectType ?? 'classification',
		phases: p.phases ?? [],
		modelStatus: p.modelStatus ?? 'untrained',
		trainedModelCount: (p.trainedModels ?? []).length,
		activeModelVersion: p.activeModelVersion ?? null,
		shadowModelVersion: p.shadowModelVersion ?? null,
		createdAt: p.createdAt ?? null,
		updatedAt: p.updatedAt ?? null
	}));

	return { projects: JSON.parse(JSON.stringify(projects)) };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();

		const form = await request.formData();
		const name = form.get('name')?.toString().trim();
		const description = form.get('description')?.toString().trim() ?? '';
		if (!name) return fail(400, { error: 'Project name is required' });

		const project = await CvProject.create({
			_id: generateId(),
			name,
			description,
			phases: [],
			trainedModels: [],
			activeModelVersion: null,
			shadowModelVersion: null
		});

		redirect(303, `/cv/projects/${project._id}`);
	}
};

export const config = { maxDuration: 60 };
