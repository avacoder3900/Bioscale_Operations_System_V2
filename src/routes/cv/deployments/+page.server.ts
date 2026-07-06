/**
 * /cv/deployments — per-stage model assignment ("Stage Models").
 *
 * The inverse view of the project Deployment tab: for each manufacturing
 * phase, see and control which model(s) run on captures there. Writes are
 * still the same two knobs on CvProject — phases[] membership and
 * activeModelVersion — so the two views can never disagree.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { AuditLog } from '$lib/server/db/models/index.js';
import { generateId } from '$lib/server/db/utils.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const [projectsRaw, photoPhases] = await Promise.all([
		CvProject.find()
			.select('_id name phases modelStatus activeModelVersion shadowModelVersion trainedModels.version trainedModels.trainedAt trainedModels.holdoutAccuracy')
			.sort({ name: 1 })
			.lean(),
		CartridgeRecord.distinct('photos.phase', { 'photos.phase': { $nin: [null, ''] } })
	]);

	const projects = (projectsRaw as any[]).map((p) => ({
		id: p._id,
		name: p.name ?? '',
		phases: p.phases ?? [],
		modelStatus: p.modelStatus ?? 'untrained',
		activeModelVersion: p.activeModelVersion ?? null,
		shadowModelVersion: p.shadowModelVersion ?? null,
		versions: (p.trainedModels ?? []).map((m: any) => ({
			version: m.version,
			trainedAt: m.trainedAt ?? null,
			holdoutAccuracy: m.holdoutAccuracy ?? null
		}))
	}));

	const phases = Array.from(
		new Set([...(photoPhases as string[]), ...projects.flatMap((p) => p.phases)])
	).sort();

	return { phases, projects: JSON.parse(JSON.stringify(projects)) };
};

async function audit(action: string, projectId: string, username: string, newData: Record<string, unknown>) {
	await AuditLog.create({
		_id: generateId(),
		tableName: 'cv_projects',
		recordId: projectId,
		action,
		newData,
		changedAt: new Date(),
		changedBy: username
	});
}

export const actions: Actions = {
	// Deploy a model at a stage: adds the phase to the project's phases[].
	assign: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();

		const form = await request.formData();
		const projectId = form.get('projectId')?.toString();
		const phase = form.get('phase')?.toString().trim();
		if (!projectId || !phase) return fail(400, { error: 'projectId and phase are required' });

		const project = (await CvProject.findById(projectId).select('_id name').lean()) as any;
		if (!project) return fail(404, { error: 'Project not found' });

		await CvProject.updateOne({ _id: projectId }, { $addToSet: { phases: phase } });
		await audit('deploy_at_phase', projectId, locals.user.username, { phase, project: project.name });
		return { success: true, message: `${project.name} now deploys at ${phase}` };
	},

	// Remove a model from a stage: pulls the phase from phases[].
	unassign: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();

		const form = await request.formData();
		const projectId = form.get('projectId')?.toString();
		const phase = form.get('phase')?.toString().trim();
		if (!projectId || !phase) return fail(400, { error: 'projectId and phase are required' });

		const project = (await CvProject.findById(projectId).select('_id name').lean()) as any;
		if (!project) return fail(404, { error: 'Project not found' });

		await CvProject.updateOne({ _id: projectId }, { $pull: { phases: phase } });
		await audit('undeploy_at_phase', projectId, locals.user.username, { phase, project: project.name });
		return { success: true, message: `${project.name} no longer deploys at ${phase}` };
	},

	// Pick which trained version is live. NOTE: activeModelVersion is
	// project-level — changing it here changes it at every phase the project
	// deploys at (the UI says so).
	setActive: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();

		const form = await request.formData();
		const projectId = form.get('projectId')?.toString();
		const version = form.get('version')?.toString() ?? '';
		if (!projectId) return fail(400, { error: 'projectId is required' });

		const project = (await CvProject.findById(projectId).select('name trainedModels.version').lean()) as any;
		if (!project) return fail(404, { error: 'Project not found' });

		if (version) {
			const exists = (project.trainedModels ?? []).some((m: any) => m.version === version);
			if (!exists) return fail(400, { error: `Version ${version} not found on ${project.name}` });
		}

		await CvProject.updateOne(
			{ _id: projectId },
			{ $set: { activeModelVersion: version || null } }
		);
		await audit('set_active_model', projectId, locals.user.username, {
			project: project.name,
			activeModelVersion: version || null
		});
		return {
			success: true,
			message: version
				? `${project.name} active model → ${version}`
				: `${project.name} deactivated (no model will run)`
		};
	}
};
