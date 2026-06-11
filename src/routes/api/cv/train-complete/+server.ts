/**
 * POST /api/cv/train-complete
 *
 * Callback hit by the GitHub Actions trainer (train_cli.py) when a run finishes.
 * Flips the matching trainedModels[] entry's status to 'ready' or 'failed' and
 * records completion metadata. Authenticated by the shared TRAIN_CALLBACK_SECRET.
 * Does NOT promote the model — promotion stays manual on the Deployment tab.
 *
 * Body: { projectId, version, status: 'trained'|'failed', message?, metrics? }
 */
import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const secret = request.headers.get('x-train-secret');
	if (!env.TRAIN_CALLBACK_SECRET || secret !== env.TRAIN_CALLBACK_SECRET) {
		throw error(401, 'Unauthorized');
	}
	await connectDB();

	const body = await request.json().catch(() => ({}));
	const { projectId, version, status, message, metrics } = body;
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });
	if (!version) return json({ error: 'version is required' }, { status: 400 });
	if (status !== 'trained' && status !== 'failed') {
		return json({ error: 'status must be "trained" or "failed"' }, { status: 400 });
	}

	const newStatus = status === 'trained' ? 'ready' : 'failed';
	const set: Record<string, unknown> = {
		'trainedModels.$.status': newStatus,
		'trainedModels.$.completedAt': new Date()
	};
	if (metrics) set['trainedModels.$.metrics'] = metrics;
	if (status === 'failed' && message) set['trainedModels.$.errorMessage'] = String(message);

	const res = await CvProject.updateOne(
		{ _id: projectId, 'trainedModels.version': version },
		{ $set: set }
	);
	if (res.matchedCount === 0) {
		return json({ error: `No project ${projectId} with version ${version}` }, { status: 404 });
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'cv_projects',
		recordId: projectId,
		action: 'UPDATE',
		newData: { trainComplete: { version, status: newStatus } },
		changedAt: new Date(),
		changedBy: 'gh-actions-trainer',
		reason: `train-complete v${version} → ${newStatus}`
	});

	return json({ success: true, projectId, version, status: newStatus, message });
};
