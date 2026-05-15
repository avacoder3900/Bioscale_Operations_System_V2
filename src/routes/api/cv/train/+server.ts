import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { triggerTraining, getTrainingStatus } from '$lib/server/services/cv-bridge';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const body = await request.json().catch(() => ({}));
	const projectId = body?.projectId;
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

	const project = (await CvProject.findById(projectId).lean()) as any;
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	await CvProject.updateOne({ _id: projectId }, { $set: { modelStatus: 'training', trainingError: null } });
	try {
		const result = await triggerTraining(projectId);
		return json({ data: result });
	} catch (err: any) {
		await CvProject.updateOne(
			{ _id: projectId },
			{ $set: { modelStatus: 'failed', trainingError: err?.message ?? 'unknown error' } }
		);
		return json({ error: err?.message ?? 'Training failed' }, { status: 500 });
	}
};

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const projectId = url.searchParams.get('projectId');
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

	await connectDB();
	try {
		const status = await getTrainingStatus(projectId);
		return json({ data: status });
	} catch (err: any) {
		return json({ error: err?.message ?? 'Status fetch failed' }, { status: 500 });
	}
};

export const config = { maxDuration: 300 };
