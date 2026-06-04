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

	return json({
		projectId,
		confidenceThreshold: project.confidenceThreshold ?? 0.5,
		imageUrls,
		labels
	});
};
