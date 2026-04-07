import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { generateId } from '$lib/server/db/utils.js';
import { env } from '$env/dynamic/private';
import { getR2Url } from '$lib/server/services/r2';
import { buildDhrKey } from '$lib/server/r2.js';
import type { RequestHandler } from './$types';

/**
 * Returns upload info for the browser.
 * Instead of a presigned R2 URL (which has TLS issues),
 * we return the Cloudflare Worker URL for direct upload.
 *
 * If cartridgeRecordId + phase are provided, the R2 key is placed
 * inside the cartridge's DHR folder: cv/{projectId}/dhr/{cartridgeId}/{phase}/...
 * Otherwise falls back to the flat project folder: cv/{projectId}/{id}_{filename}
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const { projectId, filename, contentType, cartridgeRecordId, phase } = await request.json();
	if (!projectId || !filename || !contentType) {
		return json({ error: 'projectId, filename, and contentType are required' }, { status: 400 });
	}

	const project = await CvProject.findById(projectId);
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	let key: string;
	if (cartridgeRecordId) {
		// DHR path: cv/{projectId}/dhr/{cartridgeId}/{phase}/{ts}-{filename}
		key = buildDhrKey(projectId, cartridgeRecordId, phase || 'untagged', filename);
	} else {
		// Flat project path (existing behavior)
		const id = generateId();
		const safeName = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 120);
		key = `cv/${projectId}/${id}_${safeName}`;
	}

	const workerUrl = env.R2_WORKER_URL;
	if (!workerUrl) {
		return json({ error: 'R2_WORKER_URL not configured' }, { status: 500 });
	}

	const uploadUrl = `${workerUrl}/upload/${encodeURIComponent(key)}`;
	const uploadSecret = env.R2_UPLOAD_SECRET || 'brevitest-r2-upload-key-2026';
	const publicUrl = getR2Url(key);

	return json({ uploadUrl, key, publicUrl, uploadSecret });
};
