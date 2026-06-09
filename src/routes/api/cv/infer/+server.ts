/**
 * POST /api/cv/infer — manual inference: run a specific image against a project's
 * model. Defaults to the project's activeModelVersion; caller can override with
 * `version`.
 *
 * Used for ad-hoc re-inspection from the /cv/stream lightbox or per-cartridge
 * DHR view. Phase-X auto-inference on capture uses runPhaseInference() directly
 * (no HTTP round-trip).
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { runInferenceForProject } from '$lib/server/cv/run-inference';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const body = await request.json();
	const { imageId, projectId, version } = body;
	if (!imageId) return json({ error: 'imageId is required' }, { status: 400 });
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

	const [image, project] = await Promise.all([
		CvImage.findById(imageId).lean() as any,
		CvProject.findById(projectId).lean() as any
	]);

	if (!image) return json({ error: 'Image not found' }, { status: 404 });
	if (!project) return json({ error: 'Project not found' }, { status: 404 });
	if (!image.imageUrl) return json({ error: 'Image has no URL' }, { status: 400 });
	if (!image.cartridgeTag?.cartridgeRecordId) {
		return json({ error: 'Image is not tagged to a cartridge — cannot infer' }, { status: 400 });
	}

	// If caller specified a version, temporarily swap activeModelVersion for
	// the runInferenceForProject call. Otherwise use the project's current.
	if (version) {
		const exists = (project.trainedModels ?? []).some((m: any) => m.version === version);
		if (!exists) return json({ error: `Unknown version: ${version}` }, { status: 400 });
		project.activeModelVersion = version;
		project.shadowModelVersion = null; // don't double-run shadow on manual override
	}

	if (!project.activeModelVersion) {
		return json({ error: 'Project has no active model version' }, { status: 400 });
	}

	await runInferenceForProject({
		imageId,
		imageUrl: image.imageUrl,
		cartridgeRecordId: image.cartridgeTag.cartridgeRecordId,
		phase: image.cartridgeTag?.phase ?? 'unknown',
		triggeredBy: 'manual'
	}, project);

	return json({ ok: true, projectId, version: project.activeModelVersion });
};
