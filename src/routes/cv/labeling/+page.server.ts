import { fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import type { PageServerLoad, Actions } from './$types';

/**
 * Human review queue: every image the model has inspected, shown with the
 * model's pass/fail verdict + confidence, so a person can confirm or correct it.
 * The human verdict becomes the training label (CvImage.label), closing the
 * loop: correct the model -> retrain -> better model.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const projectId = url.searchParams.get('projectId') || undefined;
	const query: Record<string, unknown> = { status: 'complete' };
	if (projectId) query.projectId = projectId;

	// Unreviewed (humanLabel null) first, then most recent.
	const inspections = (await CvInspection.find(query)
		.sort({ humanLabel: 1, completedAt: -1 })
		.limit(60)
		.lean()) as any[];

	const imageIds = [...new Set(inspections.map((i) => i.imageId).filter(Boolean))];
	const images = (await CvImage.find({ _id: { $in: imageIds } })
		.select('imageUrl thumbnailPath label filename cartridgeTag')
		.lean()) as any[];
	const imageMap = new Map(images.map((im) => [im._id, im]));

	const items = inspections.map((i) => ({ ...i, image: imageMap.get(i.imageId) ?? null }));

	const projects = (await CvProject.find()
		.select('name modelStatus')
		.sort({ createdAt: -1 })
		.lean()) as any[];

	const reviewed = items.filter((i) => i.humanLabel).length;
	const agree = items.filter((i) => i.humanLabel && i.humanLabel === i.result).length;

	return {
		items: JSON.parse(JSON.stringify(items)),
		projects: JSON.parse(JSON.stringify(projects)),
		selectedProjectId: projectId ?? null,
		stats: { total: items.length, reviewed, agree, disagree: reviewed - agree }
	};
};

export const actions: Actions = {
	setLabel: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();

		const data = await request.formData();
		const inspectionId = data.get('inspectionId')?.toString();
		const humanLabel = data.get('humanLabel')?.toString();
		if (!inspectionId || (humanLabel !== 'pass' && humanLabel !== 'fail')) {
			return fail(400, { error: 'inspectionId and humanLabel (pass|fail) are required' });
		}

		const inspection = (await CvInspection.findById(inspectionId).lean()) as any;
		if (!inspection) return fail(404, { error: 'Inspection not found' });

		await CvInspection.findByIdAndUpdate(inspectionId, {
			humanLabel,
			reviewedBy: { _id: locals.user._id, username: locals.user.username },
			reviewedAt: new Date()
		});

		// Propagate the human verdict to the training label on the source image.
		if (inspection.imageId) {
			const newLabel = humanLabel === 'pass' ? 'approved' : 'rejected';
			const image = (await CvImage.findById(inspection.imageId).lean()) as any;
			if (image) {
				const wasLabeled = image.label === 'approved' || image.label === 'rejected';
				await CvImage.findByIdAndUpdate(inspection.imageId, { label: newLabel });
				if (!wasLabeled) {
					await CvProject.findByIdAndUpdate(image.projectId, { $inc: { annotatedCount: 1 } });
				}
			}
		}

		return { success: true, inspectionId, humanLabel };
	}
};

export const config = { maxDuration: 60 };
