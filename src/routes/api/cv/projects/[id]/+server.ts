import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvSample } from '$lib/server/db/models/cv-sample.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { deleteFromR2 } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

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

	try {
		const body = await request.json();
		const allowed = ['name', 'description', 'projectType', 'tags', 'phases', 'labels'];
		const update: Record<string, unknown> = {};
		for (const key of allowed) {
			if (body[key] !== undefined) update[key] = body[key];
		}

		const project = await CvProject.findByIdAndUpdate(params.id, update, { new: true }).lean();
		if (!project) return json({ error: 'Project not found' }, { status: 404 });

		return json({ data: JSON.parse(JSON.stringify(project)) });
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	try {
		const project = await CvProject.findById(params.id).lean();
		if (!project) return json({ error: 'Project not found' }, { status: 404 });

		// Cascade delete R2 files
		const images = await CvImage.find({ projectId: params.id }).select('filePath thumbnailPath').lean();
		for (const img of images as any[]) {
			try {
				if (img.filePath) await deleteFromR2(img.filePath);
				if (img.thumbnailPath) await deleteFromR2(img.thumbnailPath);
			} catch { /* best effort */ }
		}

		await CvImage.deleteMany({ projectId: params.id });
		await CvSample.deleteMany({ projectId: params.id });
		await CvInspection.deleteMany({ projectId: params.id });
		await CvProject.findByIdAndDelete(params.id);

		return json({ success: true });
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};
