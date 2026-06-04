import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import type { RequestHandler } from './$types';

/**
 * Machine-to-machine endpoint consumed by the GitHub Actions trainer
 * (train_cli.py). Returns the labeled training set for a project. Authenticated
 * by the shared TRAIN_CALLBACK_SECRET, NOT a user session.
 */
export const GET: RequestHandler = async ({ url, request }) => {
	const secret = request.headers.get('x-train-secret');
	if (!env.TRAIN_CALLBACK_SECRET || secret !== env.TRAIN_CALLBACK_SECRET) {
		throw error(401, 'Unauthorized');
	}
	await connectDB();

	const projectId = url.searchParams.get('projectId');
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

	const project = (await CvProject.findById(projectId)
		.select('confidenceThreshold')
		.lean()) as any;
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const images = (await CvImage.find({ projectId, label: { $ne: null } })
		.select('imageUrl label')
		.lean()) as any[];

	const labels: Record<string, string> = {};
	const imageUrls: string[] = [];
	for (const img of images) {
		if (!img.imageUrl) continue;
		imageUrls.push(img.imageUrl);
		labels[img.imageUrl] = img.label;
	}

	// Hand the runner its model-upload target so it needs no R2 creds of its own.
	// Images download via their public URLs; the trained model uploads through the
	// same Cloudflare Worker the capture flow uses. R2 creds stay only in Vercel.
	const modelKey = `cv/${projectId}/models/model.onnx`;
	const workerUrl = env.R2_WORKER_URL;
	if (!workerUrl) return json({ error: 'R2_WORKER_URL not configured' }, { status: 500 });

	return json({
		projectId,
		confidenceThreshold: project.confidenceThreshold ?? 0.5,
		imageUrls,
		labels,
		modelKey,
		modelUploadUrl: `${workerUrl}/upload/${encodeURIComponent(modelKey)}`,
		modelUploadSecret: env.R2_UPLOAD_SECRET || 'brevitest-r2-upload-key-2026'
	});
};
