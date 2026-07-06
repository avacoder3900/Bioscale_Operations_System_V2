/**
 * Shared inference helpers.
 *
 * - `runInferenceForProject` — runs one project's active model (and shadow if
 *   set) against an image. Creates a CvInspection per run. Fire-and-forget;
 *   errors are caught and logged, never thrown back to the caller.
 *
 * - `runPhaseInference` — given a captured photo's phase, finds every project
 *   whose phases[] include it and has an active model, and runs each.
 */
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { generateId } from '$lib/server/db/utils.js';
import { runInference } from '$lib/server/services/cv-bridge';

interface InferenceContext {
	imageId: string;
	imageUrl: string;
	cartridgeRecordId: string;
	phase: string;
	triggeredBy?: 'auto-on-capture' | 'manual' | 'batch';
}

async function runOne(
	ctx: InferenceContext,
	projectId: string,
	modelVersion: string,
	isShadow: boolean
): Promise<void> {
	const inspectionId = generateId();

	// Insert the running record up front so operators can see the inspection
	// is in progress.
	await CvInspection.create({
		_id: inspectionId,
		imageId: ctx.imageId,
		cartridgeRecordId: ctx.cartridgeRecordId,
		phase: ctx.phase,
		projectId,
		modelVersion,
		isShadow,
		status: 'running',
		triggeredBy: ctx.triggeredBy ?? 'auto-on-capture',
		triggeredAt: new Date()
	});

	try {
		const result = await runInference(ctx.imageUrl, projectId, { modelVersion });
		await CvInspection.updateOne(
			{ _id: inspectionId },
			{ $set: {
				status: 'completed',
				result: result.result,
				passProbability: result.passProbability,
				confidenceScore: result.confidence,
				threshold: result.threshold,
				processingTimeMs: result.processing_time_ms,
				completedAt: new Date()
			}}
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await CvInspection.updateOne(
			{ _id: inspectionId },
			{ $set: { status: 'failed', errorMessage: msg, completedAt: new Date() } }
		);
		console.error(`[phase-inference] project=${projectId} version=${modelVersion} image=${ctx.imageId}:`, msg);
	}
}

export async function runInferenceForProject(ctx: InferenceContext, project: any): Promise<void> {
	if (!project.activeModelVersion) return; // nothing to run

	await runOne(ctx, project._id, project.activeModelVersion, false);

	if (project.shadowModelVersion && project.shadowModelVersion !== project.activeModelVersion) {
		await runOne(ctx, project._id, project.shadowModelVersion, true);
	}
}

export async function runPhaseInference(ctx: InferenceContext): Promise<void> {
	const projects = await CvProject.find({
		phases: ctx.phase,
		activeModelVersion: { $ne: null }
	}).select('_id activeModelVersion shadowModelVersion').lean() as any[];

	if (projects.length === 0) return;

	// Run inferences in parallel — they're independent.
	await Promise.all(projects.map(p => runInferenceForProject(ctx, p)));
}
