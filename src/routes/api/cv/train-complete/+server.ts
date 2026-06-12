/**
 * POST /api/cv/train-complete
 *
 * Callback hit by the GitHub Actions trainer (train_cli.py) when a run finishes.
 * Flips the matching trainedModels[] entry's status to 'ready' or 'failed' and
 * records completion metadata. Authenticated by the shared TRAIN_CALLBACK_SECRET.
 * Does NOT promote the model — promotion stays manual on the Deployment tab.
 *
 * Body: { projectId, version, status: 'trained'|'failed', message?, metrics?,
 *         calibratedThreshold?, scoreStats?, calibrationWarning? }
 *
 * Calibration fields (PRD CV-VERDICT-CALIBRATION-AND-GATING §5b/§6) are optional
 * and validated defensively — a malformed shape is ignored, never a 4xx, so a
 * trainer bug can't strand a finished run in 'training'.
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
	const { projectId, version, status, message, metrics, calibratedThreshold, scoreStats, calibrationWarning } = body;
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
	// Validation metrics ({f1, threshold, falsePassRate, falseFailRate, nGood, nBad})
	// go into the EXISTING `metrics: Mixed` field — only accept a plain object.
	if (metrics && typeof metrics === 'object' && !Array.isArray(metrics)) {
		set['trainedModels.$.metrics'] = metrics;
	}
	if (status === 'failed' && message) set['trainedModels.$.errorMessage'] = String(message);

	// calibratedThreshold: finite number, or explicit null (= trained but
	// uncalibrated, e.g. no labeled-bad images). Anything else is ignored.
	if (
		calibratedThreshold === null ||
		(typeof calibratedThreshold === 'number' && Number.isFinite(calibratedThreshold))
	) {
		set['trainedModels.$.calibratedThreshold'] = calibratedThreshold;
	}

	// scoreStats: requires finite rawMin/rawMax; goodMean/badMean optional.
	// Unknown keys are dropped (we rebuild the object from known fields).
	const isFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
	if (
		scoreStats &&
		typeof scoreStats === 'object' &&
		!Array.isArray(scoreStats) &&
		isFinite(scoreStats.rawMin) &&
		isFinite(scoreStats.rawMax)
	) {
		const stats: Record<string, number> = { rawMin: scoreStats.rawMin, rawMax: scoreStats.rawMax };
		if (isFinite(scoreStats.goodMean)) stats.goodMean = scoreStats.goodMean;
		if (isFinite(scoreStats.badMean)) stats.badMean = scoreStats.badMean;
		set['trainedModels.$.scoreStats'] = stats;
	}

	if (typeof calibrationWarning === 'string' && calibrationWarning.trim() !== '') {
		set['trainedModels.$.calibrationWarning'] = calibrationWarning;
	}

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
		newData: {
			trainComplete: {
				version,
				status: newStatus,
				calibratedThreshold: (set['trainedModels.$.calibratedThreshold'] ?? null) as number | null,
				calibrated: 'trainedModels.$.scoreStats' in set
			}
		},
		changedAt: new Date(),
		changedBy: 'gh-actions-trainer',
		reason: `train-complete v${version} → ${newStatus}`
	});

	return json({ success: true, projectId, version, status: newStatus, message });
};
