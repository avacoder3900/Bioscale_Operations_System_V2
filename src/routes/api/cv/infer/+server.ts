import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { generateId } from '$lib/server/db/utils.js';
import { runInference } from '$lib/server/services/cv-bridge';
import { getPhotoByImageId } from '$lib/server/cv/photo-truth.js';
import type { RequestHandler } from './$types';

/**
 * POST /api/cv/infer — manually grade one photo with a project's active
 * model. Runs in-process; records a CvInspection (machine verdict only).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	try {
		const body = await request.json();
		const { imageId, projectId } = body;
		if (!imageId) return json({ error: 'imageId is required' }, { status: 400 });
		if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

		const [found, project] = await Promise.all([
			getPhotoByImageId(imageId),
			CvProject.findById(projectId).select('activeModelVersion modelStatus').lean() as any
		]);

		if (!found) return json({ error: 'Photo not found' }, { status: 404 });
		if (!project) return json({ error: 'Project not found' }, { status: 404 });
		if (!project.activeModelVersion) {
			return json({ error: 'Project has no active model — train first' }, { status: 400 });
		}
		if (!found.photo.r2Url) {
			return json({ error: 'Photo has no stored image URL' }, { status: 422 });
		}

		const inspectionId = generateId();
		await CvInspection.create({
			_id: inspectionId,
			imageId,
			cartridgeRecordId: found.cartridgeRecordId,
			phase: found.photo.phase,
			projectId,
			modelVersion: project.activeModelVersion,
			status: 'running',
			triggeredBy: 'manual',
			triggeredAt: new Date()
		});

		let result;
		try {
			result = await runInference(found.photo.r2Url, projectId);
		} catch (e: any) {
			await CvInspection.updateOne(
				{ _id: inspectionId },
				{ $set: { status: 'failed', errorMessage: e?.message ?? String(e), completedAt: new Date() } }
			);
			return json({ error: `Inference failed: ${e?.message ?? String(e)}` }, { status: 502 });
		}

		await CvInspection.updateOne(
			{ _id: inspectionId },
			{ $set: {
				status: 'completed',
				result: result.result,
				passProbability: result.passProbability,
				confidenceScore: result.confidence,
				threshold: result.threshold,
				processingTimeMs: result.processing_time_ms,
				completedAt: new Date()
			}}
		);

		const inspection = await CvInspection.findById(inspectionId).lean();
		return json({ data: JSON.parse(JSON.stringify(inspection)) });
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};
