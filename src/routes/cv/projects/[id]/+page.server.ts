/**
 * /cv/projects/[id] — model management for one project. Tabs:
 *   - Deployment: phases[] (training + inference scope), active/shadow model version
 *   - History:    trainedModels[] table with metrics + train button + recent inspections
 *
 * Projects no longer own photos or curated membership: the training set is
 * derived from cartridge_records.photos[] whose phase is in project.phases and
 * whose human qcLabel is set. Model state lives only here.
 */
import { error, fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { triggerTraining } from '$lib/server/services/cv-bridge.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const project = await CvProject.findById(params.id).lean() as any;
	if (!project) throw error(404, 'Project not found');

	const phases: string[] = project.phases ?? [];

	// Labeled-photo counts for this project's scope: every photos[] entry on any
	// cartridge whose phase is in the project's phases, grouped by qcLabel.
	const labelStats = { approved: 0, rejected: 0, unlabeled: 0 };
	if (phases.length > 0) {
		const agg = await CartridgeRecord.aggregate([
			{ $match: { 'photos.phase': { $in: phases } } },
			{ $unwind: '$photos' },
			{ $match: { 'photos.phase': { $in: phases } } },
			{ $group: { _id: '$photos.qcLabel', count: { $sum: 1 } } }
		]);
		for (const r of agg as any[]) {
			if (r._id === 'approved') labelStats.approved = r.count;
			else if (r._id === 'rejected') labelStats.rejected = r.count;
			else labelStats.unlabeled += r.count;
		}
	}

	// Recent inspections produced by this project's models
	const recentInspections = await CvInspection.find({ projectId: params.id })
		.sort({ triggeredAt: -1 })
		.limit(20)
		.lean();

	// Phases observed in the photo record — drives the phase checkboxes.
	const observedPhases = await CartridgeRecord.distinct('photos.phase');

	return {
		project: JSON.parse(JSON.stringify({
			id: project._id,
			name: project.name ?? '',
			description: project.description ?? '',
			phases,
			activeModelVersion: project.activeModelVersion ?? null,
			shadowModelVersion: project.shadowModelVersion ?? null,
			confidenceThreshold: project.confidenceThreshold ?? 0.5,
			trainedModels: project.trainedModels ?? [],
			createdAt: project.createdAt ?? null,
			updatedAt: project.updatedAt ?? null
		})),
		labelStats,
		recentInspections: JSON.parse(JSON.stringify(recentInspections)),
		observedPhases: (observedPhases as string[]).filter(Boolean).sort()
	};
};

export const actions: Actions = {
	updateMetadata: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();
		const name = form.get('name')?.toString().trim();
		const description = form.get('description')?.toString() ?? '';
		if (!name) return fail(400, { error: 'Name is required' });
		await CvProject.updateOne({ _id: params.id }, { $set: { name, description } });
		return { success: true, section: 'metadata' };
	},

	// Set the project's phases[] — its training AND inference scope (one field).
	updatePhases: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();
		const phases = form.getAll('phase').map(v => String(v)).filter(Boolean);
		await CvProject.updateOne({ _id: params.id }, { $set: { phases } });
		return { success: true, section: 'phases' };
	},

	updateDeployment: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();
		const activeModelVersion = form.get('activeModelVersion')?.toString() || null;
		const shadowModelVersion = form.get('shadowModelVersion')?.toString() || null;

		const project = await CvProject.findById(params.id).select('trainedModels').lean() as any;
		if (!project) return fail(404, { error: 'Project not found' });

		const knownVersions = new Set((project.trainedModels ?? []).map((m: any) => m.version));
		if (activeModelVersion && !knownVersions.has(activeModelVersion)) {
			return fail(400, { error: `Unknown active version: ${activeModelVersion}` });
		}
		if (shadowModelVersion && !knownVersions.has(shadowModelVersion)) {
			return fail(400, { error: `Unknown shadow version: ${shadowModelVersion}` });
		}

		await CvProject.updateOne(
			{ _id: params.id },
			{ $set: { activeModelVersion, shadowModelVersion } }
		);
		return { success: true, section: 'deployment' };
	},

	clearShadow: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		await CvProject.updateOne({ _id: params.id }, { $set: { shadowModelVersion: null } });
		return { success: true, section: 'deployment' };
	},

	deleteProject: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		await CvProject.findByIdAndDelete(params.id);
		redirect(303, '/cv/projects');
	},

	// Train in-process from cartridge photo truth (cv-bridge). Appends a new
	// trainedModels[] entry and activates it. An optional confidence threshold
	// is persisted on the project first so training uses it.
	train: async ({ params, locals, request }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();
		const rawThreshold = form.get('confidenceThreshold')?.toString();
		const confidenceThreshold = rawThreshold ? Number(rawThreshold) : undefined;
		if (
			confidenceThreshold !== undefined &&
			(Number.isNaN(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1)
		) {
			return fail(400, { error: 'Confidence threshold must be between 0 and 1', section: 'train' });
		}
		if (confidenceThreshold !== undefined) {
			await CvProject.updateOne({ _id: params.id }, { $set: { confidenceThreshold } });
		}

		try {
			const result = await triggerTraining(params.id, {
				_id: locals.user._id,
				username: locals.user.username
			});
			const holdout = result.holdoutAccuracy != null
				? `${(result.holdoutAccuracy * 100).toFixed(1)}% holdout accuracy`
				: 'holdout skipped (too few samples)';
			return {
				success: true,
				section: 'train',
				message: `Trained version ${result.modelVersion} on ${result.samplesUsed} labeled photos (${result.approvedCount} approved / ${result.rejectedCount} rejected) — ${holdout}. It is now the active model.`
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return fail(400, { error: msg, section: 'train' });
		}
	}
};

export const config = { maxDuration: 60 };
