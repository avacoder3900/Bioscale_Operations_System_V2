/**
 * POST /api/cv/train — train a model for a project. Versioned (append-only).
 * GET  /api/cv/train?projectId=X — pull training status (proxied to cv-worker).
 *
 * After the cartridge-first refactor:
 *   - Training pulls members via resolveProjectMembers (handles composition).
 *   - Only images with qcLabel != null are sent to the worker.
 *   - Every successful training run produces a NEW version. The old ONNX is
 *     never overwritten (audit/replay/A-B-comparison requirement).
 *   - Training does NOT auto-promote — operator promotes via /cv/projects/[id]
 *     Deployment tab.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { triggerTraining, getTrainingStatus } from '$lib/server/services/cv-bridge';
import { resolveProjectMembers } from '$lib/server/cv/resolve-project-members';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';

function makeVersion(): string {
	// ISO-ish timestamp + short random suffix. Sortable, human-readable,
	// effectively unique per second per project.
	const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const suffix = Math.random().toString(36).slice(2, 6);
	return `${ts}_${suffix}`;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const body = await request.json();
	const { projectId, confidenceThreshold } = body;
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

	const project = await CvProject.findById(projectId).lean() as any;
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	// Resolve effective member list (handles live composition)
	const resolved = await resolveProjectMembers(projectId);
	if (resolved.all.length === 0) {
		return json({ error: 'Project has no members. Add images via /cv/label.' }, { status: 400 });
	}

	// Pull only labeled images for training
	const labeled = await CvImage.find({
		_id: { $in: resolved.all },
		qcLabel: { $ne: null }
	}).select('_id imageUrl qcLabel').lean() as any[];

	if (labeled.length < 5) {
		return json({
			error: `Need at least 5 labeled images to train. This project has ${labeled.length}.`,
			members: resolved.all.length,
			labeled: labeled.length
		}, { status: 400 });
	}

	const labels: Record<string, string> = {};
	const imageUrls: string[] = [];
	const sampleSnapshot: string[] = [];
	for (const img of labeled) {
		if (!img.imageUrl) continue;
		imageUrls.push(img.imageUrl);
		labels[img.imageUrl] = img.qcLabel;
		sampleSnapshot.push(img._id);
	}

	const version = makeVersion();
	const modelOutputKey = `cv/${projectId}/models/${version}.onnx`;
	const threshold = typeof confidenceThreshold === 'number'
		? confidenceThreshold
		: 0.5;

	// Append the new version BEFORE training kicks off so the worker can find
	// it in the trainedModels list while training runs.
	await CvProject.updateOne(
		{ _id: projectId },
		{ $push: { trainedModels: {
			version,
			modelPath: modelOutputKey,
			trainedAt: new Date(),
			trainedBy: { _id: locals.user._id, username: locals.user.username },
			sampleCount: imageUrls.length,
			sampleSnapshot,
			confidenceThreshold: threshold,
			notes: ''
		}}}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'cv_projects',
		recordId: projectId,
		action: 'UPDATE',
		newData: { trainStart: { version, sampleCount: imageUrls.length } },
		changedAt: new Date(),
		changedBy: locals.user.username ?? locals.user._id,
		reason: `train v${version}`
	});

	// Fire to cv-worker. Cv-worker uses project_id only as a directory key —
	// the version is encoded in modelOutputKey.
	let workerResult: any = null;
	try {
		workerResult = await triggerTraining(projectId, {
			imageUrls,
			labels,
			modelOutputKey
		});
	} catch (e) {
		// Worker unreachable / failed to start. Leave the version in place but
		// flag the failure for the operator.
		return json({
			error: e instanceof Error ? e.message : 'CV worker training failed to start',
			version,
			modelOutputKey
		}, { status: 502 });
	}

	return json({
		version,
		modelOutputKey,
		sampleCount: imageUrls.length,
		workerResult
	});
};

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const projectId = url.searchParams.get('projectId');
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

	try {
		const status = await getTrainingStatus(projectId);
		return json({ data: status });
	} catch (err: any) {
		return json({ error: err.message }, { status: 502 });
	}
};
