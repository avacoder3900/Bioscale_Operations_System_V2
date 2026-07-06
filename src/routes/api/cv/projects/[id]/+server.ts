/**
 * GET    /api/cv/projects/[id]    — full project doc
 * PATCH  /api/cv/projects/[id]    — partial update (name, description, phases,
 *                                    confidenceThreshold, activeModelVersion,
 *                                    shadowModelVersion, captureSettings)
 * DELETE /api/cv/projects/[id]    — delete the project doc only. Photos and
 *                                    inspections are NOT touched — they live on
 *                                    cartridge_records / cv_inspections.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import type { RequestHandler } from './$types';

const EDITABLE_FIELDS = [
	'name',
	'description',
	'phases',
	'confidenceThreshold',
	'activeModelVersion',
	'shadowModelVersion',
	'captureSettings'
] as const;

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const project = await CvProject.findById(params.id).lean();
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	return json({ data: JSON.parse(JSON.stringify(project)) });
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const body = await request.json();
	const update: Record<string, unknown> = {};
	for (const key of EDITABLE_FIELDS) {
		if (body[key] !== undefined) update[key] = body[key];
	}

	// activeModelVersion / shadowModelVersion validation — they must reference
	// a real trainedModels[] entry.
	if (update.activeModelVersion || update.shadowModelVersion) {
		const current = await CvProject.findById(params.id).select('trainedModels').lean() as any;
		if (!current) return json({ error: 'Project not found' }, { status: 404 });
		const knownVersions = new Set((current.trainedModels ?? []).map((m: any) => m.version));
		if (update.activeModelVersion && !knownVersions.has(update.activeModelVersion)) {
			return json({ error: `Unknown active version: ${update.activeModelVersion}` }, { status: 400 });
		}
		if (update.shadowModelVersion && !knownVersions.has(update.shadowModelVersion)) {
			return json({ error: `Unknown shadow version: ${update.shadowModelVersion}` }, { status: 400 });
		}
	}

	const project = await CvProject.findByIdAndUpdate(params.id, update, { new: true }).lean();
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	return json({ data: JSON.parse(JSON.stringify(project)) });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const result = await CvProject.findByIdAndDelete(params.id);
	if (!result) return json({ error: 'Project not found' }, { status: 404 });

	// Photos (cartridge_records.photos[]) and inspections (cv_inspections) are
	// not project-owned, so they survive project deletion untouched.
	return json({ success: true });
};
