import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { triggerTraining, getTrainingStatus } from '$lib/server/services/cv-bridge.js';
import type { RequestHandler } from './$types';

/**
 * POST /api/cv/train — train the project's classifier in-process (seconds,
 * no external service). Training data comes from cartridge_records.photos[]
 * entries whose phase is in the project's phases[] and whose qcLabel is set.
 * The new model is appended to trainedModels[] and activated.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const body = await request.json();
	const { projectId } = body;
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

	const project = (await CvProject.findById(projectId).select('_id').lean()) as any;
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	try {
		const result = await triggerTraining(projectId, {
			_id: locals.user._id,
			username: locals.user.username
		});
		return json({ data: result });
	} catch (err: any) {
		return json({ error: err.message }, { status: 400 });
	}
};

/** Poll training state / active-model metrics. */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const projectId = url.searchParams.get('projectId');
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

	try {
		const status = await getTrainingStatus(projectId);
		return json({ data: status });
	} catch (err: any) {
		return json({ error: err.message }, { status: 404 });
	}
};
