import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { generateId } from '$lib/server/db/utils.js';
import { runInference } from '$lib/server/services/cv-bridge';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	try {
		const body = await request.json();
		const { imageId, projectId } = body;
		if (!imageId) return json({ error: 'imageId is required' }, { status: 400 });
		if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

		const [image, project] = await Promise.all([
			CvImage.findById(imageId).lean() as any,
			CvProject.findById(projectId).lean() as any
		]);

		if (!image) return json({ error: 'Image not found' }, { status: 404 });
		if (!project) return json({ error: 'Project not found' }, { status: 404 });
		if (project.modelStatus !== 'trained') {
			return json({ error: 'Project model is not trained' }, { status: 400 });
		}

		// Create pending inspection
		const inspectionId = generateId();
		await CvInspection.create({
			_id: inspectionId,
			imageId,
			projectId,
			sampleId: image.sampleId,
			inspectionType: project.projectType,
			status: 'processing'
		});

		// Call Python worker
		const modelPath = `cv/${projectId}/models/model.onnx`;
		const result = await runInference(image.imageUrl, modelPath);

		// Update inspection with result
		await CvInspection.findByIdAndUpdate(inspectionId, {
			status: 'complete',
			result: result.result,
			confidenceScore: result.confidence,
			defects: result.defects || [],
			modelVersion: project.modelVersion,
			processingTimeMs: result.processing_time_ms,
			completedAt: new Date()
		});

		const inspection = await CvInspection.findById(inspectionId).lean();
		return json({ data: JSON.parse(JSON.stringify(inspection)) });
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};
