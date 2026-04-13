import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { generateId } from '$lib/server/db/utils.js';
import { env } from '$env/dynamic/private';
import { getR2Url } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

/**
 * Returns upload info for the browser.
 * Instead of a presigned R2 URL (which has TLS issues),
 * we return the Cloudflare Worker URL for direct upload.
 */
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
	// Use the original filename (which includes barcode from QR scan) with a unique prefix
	const safeName = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 120);
	const key = `cv/${projectId}/${id}_${safeName}`;

	const workerUrl = env.R2_WORKER_URL;
	if (!workerUrl) {
		return json({ error: 'R2_WORKER_URL not configured' }, { status: 500 });
	}

	const uploadUrl = `${workerUrl}/upload/${encodeURIComponent(key)}`;
	const uploadSecret = env.R2_UPLOAD_SECRET || 'brevitest-r2-upload-key-2026';
	const publicUrl = getR2Url(key);

	return json({ uploadUrl, key, publicUrl, uploadSecret });
};
