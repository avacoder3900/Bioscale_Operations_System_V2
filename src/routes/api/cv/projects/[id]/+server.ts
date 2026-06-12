/**
 * GET    /api/cv/projects/[id]    — full project doc
 * PATCH  /api/cv/projects/[id]    — partial update (name, description,
 *                                    members, composedOf, isLiveComposition,
 *                                    deployAtPhases, activeModelVersion,
 *                                    shadowModelVersion)
 * DELETE /api/cv/projects/[id]    — delete the project doc only.
 *                                    Images are NOT touched — they live free
 *                                    of project membership after the refactor.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import type { RequestHandler } from './$types';

const EDITABLE_FIELDS = [
	'name',
	'description',
	'purpose',
	'tags',
	'members',
	'composedOf',
	'isLiveComposition',
	'deployAtPhases',
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
	// a real trainedModels[] entry, and that entry must be 'ready' (a version
	// still training or failed must never be promoted — PRD CV-VERDICT-CALIBRATION §8.6).
	// Entries predating the status field are treated as ready (legacy).
	if (update.activeModelVersion || update.shadowModelVersion) {
		const current = await CvProject.findById(params.id).select('trainedModels').lean() as any;
		if (!current) return json({ error: 'Project not found' }, { status: 404 });
		const byVersion = new Map<string, any>(
			(current.trainedModels ?? []).map((m: any) => [m.version, m])
		);
		for (const [field, label] of [
			['activeModelVersion', 'active'],
			['shadowModelVersion', 'shadow']
		] as const) {
			const version = update[field];
			if (!version) continue;
			const entry = byVersion.get(String(version));
			if (!entry) {
				return json({ error: `Unknown ${label} version: ${version}` }, { status: 400 });
			}
			const entryStatus = entry.status ?? 'ready';
			if (entryStatus !== 'ready') {
				return json(
					{ error: `Cannot set ${label} version ${version}: status is '${entryStatus}', not 'ready'` },
					{ status: 400 }
				);
			}
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

	// Images are NOT deleted — they live free of project membership.
	return json({ success: true });
};
