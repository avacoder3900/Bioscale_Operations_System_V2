/**
 * POST /api/cv/train — start a training run for a project. Versioned (append-only).
 * GET  /api/cv/train?projectId=X — poll the latest version's training status.
 *
 * Serverless design: BIMS does NOT train here (Vercel can't run torch). It mints
 * a new version, records it in CvProject.trainedModels[] with status 'training',
 * then fires a GitHub `repository_dispatch`. An ephemeral Actions runner trains a
 * PaDiM model, uploads <version>.onnx to R2, and calls /api/cv/train-complete,
 * which flips the version's status to 'ready' (or 'failed'). Training does NOT
 * auto-promote — the operator promotes via the project's Deployment tab.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { dispatchWorkflow } from '$lib/server/services/github-dispatch';
import { resolveProjectMembers } from '$lib/server/cv/resolve-project-members';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';

function makeVersion(): string {
	// Sortable, human-readable, effectively unique per second per project.
	const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const suffix = Math.random().toString(36).slice(2, 6);
	return `${ts}_${suffix}`;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const body = await request.json().catch(() => ({}));
	const { projectId, confidenceThreshold } = body;
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

	const project = (await CvProject.findById(projectId).select('_id').lean()) as any;
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	// Effective member set (handles live composition), then keep only labeled.
	const resolved = await resolveProjectMembers(projectId);
	if (resolved.all.length === 0) {
		return json({ error: 'Project has no members. Add images via /cv/label.' }, { status: 400 });
	}
	const labeled = (await CvImage.find({ _id: { $in: resolved.all }, qcLabel: { $ne: null } })
		.select('_id')
		.lean()) as any[];

	if (labeled.length < 5) {
		return json(
			{
				error: `Need at least 5 labeled images to train. This project has ${labeled.length}.`,
				members: resolved.all.length,
				labeled: labeled.length
			},
			{ status: 400 }
		);
	}

	const version = makeVersion();
	const modelPath = `cv/${projectId}/models/${version}.onnx`;

	// confidenceThreshold is the OPERATOR OVERRIDE (PRD CV-VERDICT-CALIBRATION §4):
	// effective threshold = confidenceThreshold ?? calibratedThreshold ?? 0.5.
	// Do NOT default it to 0.5 here — a new entry must leave it unset so the
	// calibration computed by the trainer can win.
	const threshold =
		typeof confidenceThreshold === 'number' && Number.isFinite(confidenceThreshold)
			? confidenceThreshold
			: undefined;

	// Record the version up-front (status 'training') so the History tab shows the
	// in-flight run. The train-complete callback flips status to ready/failed.
	await CvProject.updateOne(
		{ _id: projectId },
		{
			$push: {
				trainedModels: {
					version,
					modelPath,
					trainedAt: new Date(),
					trainedBy: { _id: locals.user._id, username: locals.user.username },
					sampleCount: labeled.length,
					sampleSnapshot: labeled.map((i) => i._id),
					...(threshold !== undefined ? { confidenceThreshold: threshold } : {}),
					notes: '',
					status: 'training'
				}
			}
		}
	);

	// Hand the ephemeral runner off to GitHub Actions. If dispatch fails, mark the
	// version failed so the UI doesn't show a perpetually-"training" ghost.
	try {
		await dispatchWorkflow('train-cv-model', { projectId, version });
	} catch (e) {
		await CvProject.updateOne(
			{ _id: projectId, 'trainedModels.version': version },
			{
				$set: {
					'trainedModels.$.status': 'failed',
					'trainedModels.$.completedAt': new Date(),
					'trainedModels.$.errorMessage':
						e instanceof Error ? e.message : 'Failed to dispatch training job'
				}
			}
		);
		return json(
			{ error: e instanceof Error ? e.message : 'Failed to dispatch training job', version },
			{ status: 502 }
		);
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'cv_projects',
		recordId: projectId,
		action: 'UPDATE',
		newData: { trainDispatched: { version, sampleCount: labeled.length } },
		changedAt: new Date(),
		changedBy: locals.user.username ?? locals.user._id,
		reason: `train dispatch v${version}`
	});

	return json({
		version,
		modelPath,
		sampleCount: labeled.length,
		status: 'training',
		message: `Training dispatched — version ${version} (${labeled.length} labeled samples). A GitHub Actions runner is training; refresh the History tab in ~1–3 min.`
	});
};

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const projectId = url.searchParams.get('projectId');
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

	const project = (await CvProject.findById(projectId)
		.select('trainedModels activeModelVersion')
		.lean()) as any;
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const models = (project.trainedModels ?? []) as any[];
	const latest = models.length > 0 ? models[models.length - 1] : null;

	return json({
		data: {
			projectId,
			activeModelVersion: project.activeModelVersion ?? null,
			latest: latest
				? {
						version: latest.version,
						status: latest.status ?? 'ready',
						trainedAt: latest.trainedAt,
						completedAt: latest.completedAt ?? null,
						sampleCount: latest.sampleCount ?? null,
						errorMessage: latest.errorMessage ?? null,
						// Calibration fields (persisted by the train-complete callback;
						// both the GH Actions trainer and the long-lived worker /train
						// path report through that same callback).
						confidenceThreshold: latest.confidenceThreshold ?? null,
						calibratedThreshold: latest.calibratedThreshold ?? null,
						scoreStats: latest.scoreStats ?? null,
						calibrationWarning: latest.calibrationWarning ?? null,
						metrics: latest.metrics ?? null
					}
				: null
		}
	});
};
