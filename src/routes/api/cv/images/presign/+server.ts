import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { generateId } from '$lib/server/db/utils.js';
import { env } from '$env/dynamic/private';
import { getR2Url, buildCvNamedKey } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

/**
 * Returns upload info for the browser. After the cartridge-first refactor,
 * projectId is optional. If absent, files land under a generic captures prefix.
 *
 * Returns the Cloudflare Worker URL for direct browser upload (avoids R2 TLS
 * issues with direct browser PUTs).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const { projectId, filename, contentType } = await request.json();
	if (!filename || !contentType) {
		return json({ error: 'filename and contentType are required' }, { status: 400 });
	}

	// Project is optional now. If provided, validate it exists (so legacy callers
	// still get the right key prefix).
	let projectName: string = 'captures';
	if (projectId) {
		const project = await CvProject.findById(projectId).select('name').lean() as any;
		if (project?.name) {
			projectName = project.name;
		}
	}

	const id = generateId();
	const key = buildCvNamedKey(projectName, id, filename);

	const workerUrl = env.R2_WORKER_URL;
	if (!workerUrl) {
		return json({ error: 'R2_WORKER_URL not configured' }, { status: 500 });
	}

	const uploadUrl = `${workerUrl}/upload/${encodeURIComponent(key)}`;
	const uploadSecret = env.R2_UPLOAD_SECRET || 'brevitest-r2-upload-key-2026';
	const publicUrl = getR2Url(key);

	return json({ uploadUrl, key, publicUrl, uploadSecret });
};
