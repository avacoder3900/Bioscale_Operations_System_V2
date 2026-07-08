/**
 * /cv/projects — list every CV project (training set). Empty list after the
 * cartridge-first wipe — operators create projects from /cv/label or here.
 *
 * Create is the "make a CV model" entry point (CV-PIPELINE-V2 Stage 3): a
 * project must be scoped to the manufacturing phases whose labeled images it
 * trains on (or flagged as a master model that trains on everything), so the
 * trainer can assemble by qcLabel + cartridgeTag.phase without guesswork.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import type { Actions, PageServerLoad } from './$types';

// Canonical manufacturing phases — the union of the /capture station list
// (src/routes/capture/+page.server.ts DEFAULT_PHASES) and the phase-pinned
// inspect/forensic pages (wax-inspect → wax_filled, post-mortem-inspect →
// post_mortem, forensic-capture → post_run). Do not invent new names here:
// capture routes photos to deployed models by exact-string phase match.
const CANONICAL_PHASES = [
	'wax_filled',
	'reagent_filled',
	'inspected',
	'sealed',
	'oven_cured',
	'qaqc_released',
	'post_run',
	'post_mortem'
];

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const projectsRaw = await CvProject.find()
		.sort({ createdAt: -1 })
		.select('_id name description purpose projectType tags phases view isMasterModel members composedOf isLiveComposition deployAtPhases activeModelVersion shadowModelVersion trainedModels modelStatus createdAt updatedAt')
		.lean();

	const projects = (projectsRaw as any[]).map(p => ({
		id: p._id,
		name: p.name ?? '',
		description: p.description ?? '',
		purpose: p.purpose ?? '',
		projectType: p.projectType ?? 'classification',
		tags: p.tags ?? [],
		phases: p.phases ?? [],
		isMasterModel: !!p.isMasterModel,
		view: p.view ?? null,
		memberCount: (p.members ?? []).length,
		composedOfCount: (p.composedOf ?? []).length,
		isLiveComposition: !!p.isLiveComposition,
		deployAtPhases: p.deployAtPhases ?? [],
		trainedModelCount: (p.trainedModels ?? []).length,
		modelStatus: p.modelStatus ?? 'untrained',
		activeModelVersion: p.activeModelVersion ?? null,
		shadowModelVersion: p.shadowModelVersion ?? null,
		createdAt: p.createdAt ?? null,
		updatedAt: p.updatedAt ?? null
	}));

	return {
		projects: JSON.parse(JSON.stringify(projects)),
		canonicalPhases: CANONICAL_PHASES
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();

		const form = await request.formData();
		const name = form.get('name')?.toString().trim();
		const description = form.get('description')?.toString().trim() ?? '';
		const purpose = form.get('purpose')?.toString().trim() ?? '';
		const projectType = form.get('projectType')?.toString().trim() || 'classification';
		const isMasterModel = form.get('isMasterModel') === 'on';
		const requestedPhases = form.getAll('phases').map(v => String(v)).filter(Boolean);
		// View scope (CV-PIPELINE-V2 top/bottom split): empty select = any view (null).
		const viewRaw = form.get('view')?.toString().trim() || '';
		if (viewRaw && viewRaw !== 'top' && viewRaw !== 'bottom') {
			return fail(400, { error: `View must be 'top', 'bottom', or blank (any view).` });
		}
		const view = viewRaw ? viewRaw : null;
		if (!name) return fail(400, { error: 'Project name is required' });

		// Phase scoping is what makes training assembly deterministic: at least
		// one canonical phase, unless this is a master model (trains on all
		// labeled images regardless of phase — mutually exclusive with phases).
		const invalid = requestedPhases.filter(ph => !CANONICAL_PHASES.includes(ph));
		if (invalid.length > 0) {
			return fail(400, { error: `Unknown phase(s): ${invalid.join(', ')}` });
		}
		if (isMasterModel && requestedPhases.length > 0) {
			return fail(400, { error: 'A master model trains on all phases — clear the phase selection or uncheck Master model.' });
		}
		if (!isMasterModel && requestedPhases.length === 0) {
			return fail(400, { error: 'Select at least one training phase, or mark the project as a master model.' });
		}
		const phases = isMasterModel ? [] : requestedPhases;

		const project = await CvProject.create({
			_id: generateId(),
			name,
			description,
			purpose,
			projectType,
			phases,
			isMasterModel,
			view,
			tags: [],
			members: [],
			composedOf: [],
			isLiveComposition: false,
			deployAtPhases: [],
			trainedModels: [],
			activeModelVersion: null,
			shadowModelVersion: null
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cv_projects',
			recordId: project._id,
			action: 'cv_project_create',
			newData: { name, description, purpose, projectType, phases, view, isMasterModel },
			changedAt: new Date(),
			changedBy: locals.user.username ?? locals.user._id,
			reason: `cv_project_create "${name}" (${isMasterModel ? 'master model' : phases.join(', ')})`
		});

		redirect(303, `/cv/projects/${project._id}`);
	}
};

export const config = { maxDuration: 60 };
