/**
 * /cv/projects/[id] — project detail with tabs:
 *   - Members:     view/add/remove member imageIds
 *   - Composition: composedOf + isLiveComposition
 *   - Deployment:  deployAtPhases, activeModelVersion, shadowModelVersion
 *   - History:     trainedModels[] table + recent inspections
 *   - Training:    (deferred to PRD 3 Phase 2)
 */
import { error, fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { getR2Url } from '$lib/server/services/r2';
import type { Actions, PageServerLoad } from './$types';

const PREVIEW_LIMIT = 60;

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const project = await CvProject.findById(params.id).lean() as any;
	if (!project) throw error(404, 'Project not found');

	const memberIds: string[] = project.members ?? [];

	// Resolve live composition (one level deep — siblings flatten their own members).
	let liveAdditions: string[] = [];
	if (project.isLiveComposition && (project.composedOf ?? []).length > 0) {
		const children = await CvProject.find({ _id: { $in: project.composedOf } })
			.select('members')
			.lean() as any[];
		const set = new Set<string>(memberIds);
		for (const c of children) {
			for (const m of c.members ?? []) {
				if (!set.has(m)) {
					set.add(m);
					liveAdditions.push(m);
				}
			}
		}
	}

	const effectiveIds = [...memberIds, ...liveAdditions];
	const totalEffective = effectiveIds.length;

	// Preview slice (first N for the Members tab)
	const previewIds = effectiveIds.slice(0, PREVIEW_LIMIT);
	const previewImages = previewIds.length > 0
		? await CvImage.find({ _id: { $in: previewIds } })
			.select('_id cartridgeImageNumber cartridgeTag filePath imageUrl thumbnailPath qcLabel capturedAt')
			.lean()
		: [];

	// Stats: how many of the effective set are labeled
	const labelCounts = effectiveIds.length > 0
		? await CvImage.aggregate([
			{ $match: { _id: { $in: effectiveIds } } },
			{ $group: { _id: '$qcLabel', count: { $sum: 1 } } }
		])
		: [];
	const labelMap = new Map<string | null, number>();
	for (const r of labelCounts as any[]) labelMap.set(r._id, r.count);

	// Other projects (for composition picker)
	const otherProjects = await CvProject.find({ _id: { $ne: params.id } })
		.select('_id name members composedOf')
		.lean() as any[];

	// Recent inspections produced by this project's models
	const recentInspections = await CvInspection.find({ projectId: params.id })
		.sort({ triggeredAt: -1 })
		.limit(20)
		.lean();

	// Phases observed in the data — drives the deployAtPhases checkboxes
	const observedPhases = await CvImage.distinct('cartridgeTag.phase');

	return {
		project: {
			id: project._id,
			name: project.name ?? '',
			description: project.description ?? '',
			purpose: project.purpose ?? '',
			tags: project.tags ?? [],
			members: memberIds,
			memberCount: memberIds.length,
			composedOf: project.composedOf ?? [],
			isLiveComposition: !!project.isLiveComposition,
			deployAtPhases: project.deployAtPhases ?? [],
			activeModelVersion: project.activeModelVersion ?? null,
			shadowModelVersion: project.shadowModelVersion ?? null,
			trainedModels: project.trainedModels ?? [],
			createdAt: project.createdAt ?? null,
			updatedAt: project.updatedAt ?? null
		},
		effectiveTotal: totalEffective,
		liveAdditionCount: liveAdditions.length,
		previewImages: (previewImages as any[]).map(img => ({
			id: img._id,
			cartridgeImageNumber: img.cartridgeImageNumber ?? null,
			cartridgeRecordId: img.cartridgeTag?.cartridgeRecordId ?? null,
			phase: img.cartridgeTag?.phase ?? null,
			qcLabel: img.qcLabel ?? null,
			thumbnailUrl: img.thumbnailPath ? getR2Url(img.thumbnailPath) : (img.imageUrl || (img.filePath ? getR2Url(img.filePath) : null)),
			capturedAt: img.capturedAt ?? null
		})),
		labelStats: {
			approved: labelMap.get('approved') ?? 0,
			rejected: labelMap.get('rejected') ?? 0,
			unlabeled: labelMap.get(null) ?? 0
		},
		otherProjects: otherProjects.map(p => ({
			id: p._id,
			name: p.name ?? '',
			memberCount: (p.members ?? []).length
		})),
		recentInspections: JSON.parse(JSON.stringify(recentInspections)),
		observedPhases: (observedPhases as string[]).filter(Boolean).sort()
	};
};

export const actions: Actions = {
	updateMetadata: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();
		const update: Record<string, any> = {
			name: form.get('name')?.toString().trim(),
			description: form.get('description')?.toString() ?? '',
			purpose: form.get('purpose')?.toString() ?? ''
		};
		if (!update.name) return fail(400, { error: 'Name is required' });
		await CvProject.updateOne({ _id: params.id }, { $set: update });
		return { success: true, section: 'metadata' };
	},

	removeMember: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();
		const imageId = form.get('imageId')?.toString();
		if (!imageId) return fail(400, { error: 'imageId required' });
		await CvProject.updateOne({ _id: params.id }, { $pull: { members: imageId } });
		return { success: true, section: 'members' };
	},

	updateComposition: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();
		const composedOf = form.getAll('composedOf').map(v => String(v)).filter(Boolean);
		const isLiveComposition = form.get('isLiveComposition') === 'on';

		// Cycle guard: project can't compose itself.
		if (composedOf.includes(params.id)) {
			return fail(400, { error: 'Project cannot include itself in composedOf' });
		}

		await CvProject.updateOne(
			{ _id: params.id },
			{ $set: { composedOf, isLiveComposition } }
		);
		return { success: true, section: 'composition' };
	},

	updateDeployment: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();
		const deployAtPhases = form.getAll('phase').map(v => String(v)).filter(Boolean);
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
			{ $set: { deployAtPhases, activeModelVersion, shadowModelVersion } }
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
	}
};

export const config = { maxDuration: 60 };
