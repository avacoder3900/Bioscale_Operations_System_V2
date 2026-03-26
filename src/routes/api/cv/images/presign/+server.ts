import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { generateId } from '$lib/server/db/utils.js';
import { getPresignedUploadUrl, getR2Url } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const { projectId, filename, contentType } = await request.json();
	if (!projectId || !filename || !contentType) {
		return json({ error: 'projectId, filename, and contentType are required' }, { status: 400 });
	}

	const project = await CvProject.findById(projectId);
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const id = generateId();
	const ext = filename.split('.').pop() || 'jpg';
	const key = `cv/${projectId}/${id}.${ext}`;

	const uploadUrl = await getPresignedUploadUrl(key, contentType);
	const publicUrl = getR2Url(key);

	return json({ uploadUrl, key, publicUrl });
};
