import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import { triggerTraining } from '$lib/server/services/cv-bridge';
import type { RequestHandler } from './$types';

/**
 * Train a project's classifier IN-PROCESS (sharp embeddings + logistic
 * regression via cv-bridge — no GitHub-dispatched runner, no torch). Each run
 * appends an immutable trainedModels[] version with its exact training-set
 * manifest and an automatic holdout verification against the project's
 * verify gate (CV-PIPELINE-V2 Stage 3/4). Training runs synchronously and
 * the response carries the new version + verification result.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	try {
		const body = await request.json();
		const { projectId } = body;
		if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

		const project = (await CvProject.findById(projectId).select('_id name').lean()) as any;
		if (!project) return json({ error: 'Project not found' }, { status: 404 });

		let result;
		try {
			result = await triggerTraining(projectId, {
				_id: locals.user._id,
				username: locals.user.username
			});
		} catch (err: any) {
			const msg = err?.message ?? String(err);
			// Guardrail failures (too few labeled images / single class) are
			// caller errors, not server faults.
			return json({ error: msg }, { status: msg.startsWith('Need') ? 400 : 500 });
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cv_projects',
			recordId: projectId,
			action: 'cv_train',
			newData: {
				version: result.version,
				versionStatus: result.versionStatus,
				samplesUsed: result.samplesUsed,
				approvedCount: result.approvedCount,
				rejectedCount: result.rejectedCount,
				newSincePrevious: result.newSincePrevious,
				holdoutCount: result.verification.holdoutCount,
				balancedAccuracy: result.verification.balancedAccuracy,
				gatePassed: result.verification.passed
			},
			changedAt: new Date(),
			changedBy: locals.user.username
		});

		return json({
			data: {
				projectId,
				status: result.status,
				version: result.version,
				versionStatus: result.versionStatus,
				modelVersion: result.modelVersion,
				samplesUsed: result.samplesUsed,
				approvedCount: result.approvedCount,
				rejectedCount: result.rejectedCount,
				trainingAccuracy: result.trainingAccuracy,
				embeddedNow: result.embeddedNow,
				newSincePrevious: result.newSincePrevious,
				verification: result.verification,
				gate: result.verification.gate,
				gatePassed: result.verification.passed,
				durationMs: result.durationMs
			}
		});
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};

/** Poll training state. Source of truth is CvProject.modelStatus (mirrored by cv-bridge). */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const projectId = url.searchParams.get('projectId');
	if (!projectId) return json({ error: 'projectId is required' }, { status: 400 });

	const project = (await CvProject.findById(projectId)
		.select('modelStatus modelVersion updatedAt')
		.lean()) as any;
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	return json({
		data: {
			projectId,
			modelStatus: project.modelStatus,
			modelVersion: project.modelVersion,
			updatedAt: project.updatedAt
		}
	});
};
