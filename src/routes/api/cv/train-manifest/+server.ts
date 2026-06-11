/**
 * GET /api/cv/train-manifest?projectId=X&version=Y
 *
 * Machine-to-machine endpoint consumed by the GitHub Actions trainer
 * (train_cli.py). Authenticated by the shared TRAIN_CALLBACK_SECRET header, NOT a
 * user session. Returns the labeled training set (public image URLs + labels) and
 * a model-upload target, so the runner needs NO R2 credentials of its own:
 *   - images download via their public R2 URLs
 *   - the trained model uploads through the same Cloudflare Worker the capture
 *     flow uses (R2 creds stay only in Vercel).
 */
import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { resolveProjectMembers } from '$lib/server/cv/resolve-project-members';
import { getR2Url } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, request }) => {
	const secret = request.headers.get('x-train-secret');
	if (!env.TRAIN_CALLBACK_SECRET || secret !== env.TRAIN_CALLBACK_SECRET) {
		throw error(401, 'Unauthorized');
	}
	await connectDB();

	const projectId = url.searchParams.get('projectId');
	const version = url.searchParams.get('version');
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });
	if (!version) return json({ error: 'version is required' }, { status: 400 });

	const project = (await CvProject.findById(projectId).select('trainedModels').lean()) as any;
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const entry = (project.trainedModels ?? []).find((m: any) => m.version === version);
	if (!entry) return json({ error: `Unknown version ${version}` }, { status: 404 });

	// Effective member set (handles live composition), labeled only.
	const resolved = await resolveProjectMembers(projectId);
	const images = (await CvImage.find({ _id: { $in: resolved.all }, qcLabel: { $ne: null } })
		.select('imageUrl filePath qcLabel')
		.lean()) as any[];

	const labels: Record<string, string> = {};
	const imageUrls: string[] = [];
	for (const img of images) {
		const u = img.imageUrl || (img.filePath ? getR2Url(img.filePath) : null);
		if (!u) continue;
		imageUrls.push(u);
		labels[u] = img.qcLabel; // 'approved' | 'rejected'
	}
	const approved = Object.values(labels).filter((l) => l === 'approved').length;

	const modelKey = entry.modelPath || `cv/${projectId}/models/${version}.onnx`;
	const workerUrl = env.R2_WORKER_URL;
	if (!workerUrl) return json({ error: 'R2_WORKER_URL not configured' }, { status: 500 });

	return json({
		projectId,
		version,
		confidenceThreshold: entry.confidenceThreshold ?? 0.5,
		counts: { labeled: imageUrls.length, approved, rejected: imageUrls.length - approved },
		imageUrls,
		labels,
		modelKey,
		modelUploadUrl: `${workerUrl}/upload/${encodeURIComponent(modelKey)}`,
		modelUploadSecret: env.R2_UPLOAD_SECRET || 'brevitest-r2-upload-key-2026'
	});
};
