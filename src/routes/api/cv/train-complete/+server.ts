import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import type { RequestHandler } from './$types';

/**
 * Callback hit by the GitHub Actions trainer when a run finishes. Flips the
 * project's modelStatus to 'trained' (or 'failed') and records the new model
 * version. Authenticated by the shared TRAIN_CALLBACK_SECRET.
 */
export const POST: RequestHandler = async ({ request }) => {
	const secret = request.headers.get('x-train-secret');
	if (!env.TRAIN_CALLBACK_SECRET || secret !== env.TRAIN_CALLBACK_SECRET) {
		throw error(401, 'Unauthorized');
	}
	await connectDB();

	const body = await request.json();
	const { projectId, status, modelVersion, message } = body;
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });
	if (status !== 'trained' && status !== 'failed') {
		return json({ error: 'status must be "trained" or "failed"' }, { status: 400 });
	}

	const update: Record<string, unknown> = { modelStatus: status };
	if (status === 'trained' && modelVersion) update.modelVersion = modelVersion;

	const project = await CvProject.findByIdAndUpdate(projectId, update, { new: true })
		.select('modelStatus modelVersion')
		.lean();
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	return json({ success: true, projectId, status, modelVersion, message });
};
