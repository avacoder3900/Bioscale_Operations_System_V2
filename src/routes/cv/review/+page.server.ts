/**
 * /cv/review — needs-review queue (CV-PIPELINE-V2 Stage 5).
 *
 * Every non-shadow deployed-model verdict that no human has reviewed yet:
 * cv_inspections where result != null, humanLabel == null, isShadow != true,
 * status 'completed'. Newest first, filterable by project and phase.
 *
 * One-click Agree / Overrule writes humanLabel + reviewedBy/At on the
 * inspection and mirrors the effective verdict onto the image's qcLabel,
 * which feeds the next training iteration.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import { requirePermission } from '$lib/server/permissions';
import { getR2Url } from '$lib/server/services/r2';
import type { PageServerLoad, Actions } from './$types';

const QUEUE_LIMIT = 100;

// Model verdict present, no human review yet, non-shadow, run finished.
// Backed by the { result, humanLabel, isShadow } index on cv_inspections.
const QUEUE_FILTER = {
	result: { $ne: null },
	humanLabel: null,
	isShadow: { $ne: true },
	status: 'completed'
} as const;

export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'cv:read');
	await connectDB();

	const project = url.searchParams.get('project') || '';
	const phase = url.searchParams.get('phase') || '';

	const filter: Record<string, any> = { ...QUEUE_FILTER };
	if (project) filter.projectId = project;
	if (phase) filter.phase = phase;

	const [inspectionsRaw, total, filteredTotal, queuePhases, queueProjectIds] = await Promise.all([
		CvInspection.find(filter)
			.sort({ createdAt: -1 })
			.limit(QUEUE_LIMIT)
			.select('_id imageId projectId result confidenceScore modelVersion phase cartridgeRecordId completedAt createdAt')
			.lean(),
		// Total queue size regardless of the active filters (matches the nav badge).
		CvInspection.countDocuments(QUEUE_FILTER),
		CvInspection.countDocuments(filter),
		// Filter dropdown sources — only values actually present in the queue.
		CvInspection.distinct('phase', QUEUE_FILTER),
		CvInspection.distinct('projectId', QUEUE_FILTER)
	]);

	const inspections = inspectionsRaw as any[];

	// Join the images (thumbnail, cartridge, capture metadata) and project names.
	const imageIds = [...new Set(inspections.map(i => i.imageId).filter(Boolean))];
	const projectIds = [...new Set([...queueProjectIds, ...inspections.map(i => i.projectId)].filter(Boolean))];
	const [imagesRaw, projectsRaw] = await Promise.all([
		CvImage.find({ _id: { $in: imageIds } })
			.select('_id filePath imageUrl thumbnailPath cartridgeTag capturedAt capturedBy')
			.lean(),
		CvProject.find({ _id: { $in: projectIds } }).select('_id name').sort({ name: 1 }).lean()
	]);

	const imageById = new Map((imagesRaw as any[]).map(img => [img._id, img]));
	const projectNameById = new Map((projectsRaw as any[]).map(p => [p._id, p.name ?? '']));

	const items = inspections.map(insp => {
		const img = imageById.get(insp.imageId);
		const fullUrl = img ? (img.imageUrl || (img.filePath ? getR2Url(img.filePath) : null)) : null;
		return {
			inspectionId: insp._id,
			imageId: insp.imageId ?? null,
			thumbnailUrl: img?.thumbnailPath ? getR2Url(img.thumbnailPath) : fullUrl,
			url: fullUrl,
			cartridgeRecordId: insp.cartridgeRecordId ?? img?.cartridgeTag?.cartridgeRecordId ?? null,
			phase: insp.phase ?? img?.cartridgeTag?.phase ?? null,
			capturedAt: img?.capturedAt ?? null,
			capturedByUsername: img?.capturedBy?.username ?? null,
			result: insp.result,
			confidenceScore: insp.confidenceScore ?? null,
			modelVersion: insp.modelVersion ?? null,
			projectId: insp.projectId ?? null,
			projectName: projectNameById.get(insp.projectId) ?? null,
			verdictAt: insp.completedAt ?? insp.createdAt ?? null
		};
	});

	return {
		items: JSON.parse(JSON.stringify(items)),
		total,
		filteredTotal,
		shown: items.length,
		filters: { project, phase },
		projectOptions: (queueProjectIds as string[]).filter(Boolean).sort()
			.map(id => ({ id, name: projectNameById.get(id) || id })),
		phaseOptions: (queuePhases as string[]).filter(Boolean).sort()
	};
};

export const actions: Actions = {
	review: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'cv:write');
		await connectDB();

		const form = await request.formData();
		const inspectionId = form.get('inspectionId')?.toString();
		const decision = form.get('decision')?.toString();
		if (!inspectionId) return fail(400, { error: 'inspectionId required' });
		if (decision !== 'agree' && decision !== 'overrule') {
			return fail(400, { error: `Invalid decision: ${decision}` });
		}

		const inspection: any = await CvInspection.findById(inspectionId).lean();
		if (!inspection) return fail(404, { error: 'Inspection not found' });
		if (inspection.result !== 'pass' && inspection.result !== 'fail') {
			return fail(400, { error: 'Inspection has no model verdict to review' });
		}
		if (inspection.humanLabel) return fail(400, { error: 'Inspection already reviewed' });

		const humanLabel = decision === 'agree'
			? inspection.result
			: (inspection.result === 'pass' ? 'fail' : 'pass');
		const reviewer = { _id: locals.user._id, username: locals.user.username };
		const now = new Date();

		await CvInspection.updateOne(
			{ _id: inspectionId },
			{ $set: { humanLabel, reviewedBy: reviewer, reviewedAt: now } }
		);

		// Mirror the effective verdict onto the image's qcLabel — this is what
		// the trainer reads for the next iteration.
		const qcLabel = humanLabel === 'pass' ? 'approved' : 'rejected';
		if (inspection.imageId) {
			await CvImage.updateOne(
				{ _id: inspection.imageId },
				{ $set: { qcLabel, qcLabeledBy: reviewer, qcLabeledAt: now } }
			);
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cv_inspections',
			recordId: inspectionId,
			action: 'cv_review',
			newData: {
				decision,
				modelResult: inspection.result,
				modelVersion: inspection.modelVersion ?? null,
				humanLabel,
				imageId: inspection.imageId ?? null,
				qcLabel
			},
			changedAt: now,
			changedBy: locals.user.username ?? locals.user._id,
			reason: `cv_review ${decision}: model ${inspection.result} -> human ${humanLabel}`
		});

		return { success: true, inspectionId, humanLabel };
	}
};

export const config = { maxDuration: 60 };
