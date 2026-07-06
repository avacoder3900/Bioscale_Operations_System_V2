/**
 * GET  /api/cv/projects — list all projects with model summary stats.
 * POST /api/cv/projects — create a new project.
 *
 * Projects organize ONE model per manufacturing concern. They do NOT own
 * photos or human labels — the training set is derived from
 * cartridge_records.photos[] whose phase ∈ project.phases and whose qcLabel is
 * set (see cv-bridge). This route only touches model-organizer fields.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const projects = await CvProject.find().sort({ createdAt: -1 }).lean() as any[];

	// Summarize each project: identity + model status + the active model's
	// metrics. The bulky classifier weight arrays are dropped from the list
	// response — callers that need them fetch the single project by id.
	const data = projects.map((p) => {
		const trainedModels: any[] = Array.isArray(p.trainedModels) ? p.trainedModels : [];
		const active = trainedModels.find((m) => m.version === p.activeModelVersion) ?? null;
		return {
			_id: p._id,
			name: p.name,
			description: p.description ?? '',
			projectType: p.projectType ?? 'classification',
			phases: p.phases ?? [],
			modelStatus: p.modelStatus ?? 'untrained',
			trainingError: p.trainingError ?? null,
			activeModelVersion: p.activeModelVersion ?? null,
			shadowModelVersion: p.shadowModelVersion ?? null,
			confidenceThreshold: p.confidenceThreshold ?? 0.5,
			captureSettings: p.captureSettings ?? null,
			trainedModelsCount: trainedModels.length,
			activeModel: active
				? {
						version: active.version,
						trainedAt: active.trainedAt ?? null,
						samplesUsed: active.samplesUsed ?? 0,
						approvedCount: active.approvedCount ?? 0,
						rejectedCount: active.rejectedCount ?? 0,
						trainingAccuracy: active.trainingAccuracy ?? null,
						holdoutAccuracy: active.holdoutAccuracy ?? null,
						holdoutF1: active.holdoutF1 ?? null,
						confidenceThreshold: active.confidenceThreshold ?? null
					}
				: null,
			createdAt: p.createdAt,
			updatedAt: p.updatedAt
		};
	});

	return json({ data: JSON.parse(JSON.stringify(data)) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const body = await request.json();
	if (!body.name) return json({ error: 'name is required' }, { status: 400 });

	const project = await CvProject.create({
		_id: generateId(),
		name: body.name,
		description: body.description ?? '',
		...(body.projectType ? { projectType: body.projectType } : {}),
		phases: Array.isArray(body.phases) ? body.phases : [],
		...(typeof body.confidenceThreshold === 'number' ? { confidenceThreshold: body.confidenceThreshold } : {}),
		...(body.captureSettings ? { captureSettings: body.captureSettings } : {}),
		trainedModels: [],
		activeModelVersion: null,
		shadowModelVersion: null
	});

	return json({ data: JSON.parse(JSON.stringify(project)) }, { status: 201 });
};
