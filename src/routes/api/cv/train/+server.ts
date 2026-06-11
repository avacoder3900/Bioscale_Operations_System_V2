import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { dispatchWorkflow } from '$lib/server/services/github-dispatch';
import type { RequestHandler } from './$types';

/**
 * Start training. BIMS does NOT train here (Vercel can't run torch); it fires a
 * GitHub Actions `repository_dispatch`, which runs an ephemeral runner that
 * trains, uploads model.onnx to R2, and calls /api/cv/train-complete when done.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	try {
		const body = await request.json();
		const { projectId } = body;
		if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

		const project = (await CvProject.findById(projectId).lean()) as any;
		if (!project) return json({ error: 'Project not found' }, { status: 404 });

		// Require enough labeled images before spending a runner.
		const labeledCount = await CvImage.countDocuments({ projectId, label: { $ne: null } });
		if (labeledCount < 5) {
			return json({ error: 'Need at least 5 labeled images to train' }, { status: 400 });
		}

		await dispatchWorkflow('train-cv-model', { projectId });
		await CvProject.findByIdAndUpdate(projectId, { modelStatus: 'training' });

		return json({
			data: { projectId, status: 'training', labeledCount, message: 'Training dispatched' }
		});
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};

/** Poll training state. Source of truth is CvProject.modelStatus (set by the callback). */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const projectId = url.searchParams.get('projectId');
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

	const project = (await CvProject.findById(projectId)
		.select('modelStatus modelVersion updatedAt')
		.lean()) as any;
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	return json({
		data: {
			projectId,
			modelStatus: project.modelStatus,
			modelVersion: project.modelVersion,
			updatedAt: project.updatedAt
		}
	});
};
