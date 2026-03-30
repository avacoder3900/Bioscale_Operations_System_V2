import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { triggerTraining, getTrainingStatus } from '$lib/server/services/cv-bridge';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	try {
		const body = await request.json();
		const { projectId } = body;
		if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

		const project = await CvProject.findById(projectId).lean() as any;
		if (!project) return json({ error: 'Project not found' }, { status: 404 });

		// Gather labeled images
		const images = await CvImage.find({ projectId, label: { $ne: null } })
			.select('imageUrl label')
			.lean() as any[];

		if (images.length < 5) {
			return json({ error: 'Need at least 5 labeled images to train' }, { status: 400 });
		}

		const labels: Record<string, string> = {};
		const imageUrls: string[] = [];
		for (const img of images) {
			imageUrls.push(img.imageUrl);
			labels[img.imageUrl] = img.label;
		}

		await CvProject.findByIdAndUpdate(projectId, { modelStatus: 'training' });

		const result = await triggerTraining(projectId, {
			imageUrls,
			labels,
			modelOutputKey: `cv/${projectId}/models/model.onnx`
		});

		return json({ data: result });
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const projectId = url.searchParams.get('projectId');
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

	try {
		const status = await getTrainingStatus(projectId);
		return json({ data: status });
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};
