/**
 * Shared inference helpers.
 *
 * - `runInferenceForProject` — runs one project's active model (and shadow if set)
 *   against an image. Creates CvInspection records for each. Fire-and-forget;
 *   errors are caught and logged, never thrown back to the caller.
 *
 * - `runPhaseInference` — given a captured image's phase, finds every project
 *   that deploys at that phase and runs inference for each.
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
	project: any,
	version: string,
	modelPath: string,
	confidenceThreshold: number,
	isShadow: boolean
): Promise<void> {
	const inspectionId = generateId();
	const triggeredAt = new Date();

	// Insert a queued/running record up front so the operator can see the
	// inspection is in progress, even if the worker is slow.
	await CvInspection.create({
		_id: inspectionId,
		imageId: ctx.imageId,
		cartridgeRecordId: ctx.cartridgeRecordId,
		phase: ctx.phase,
		projectId: project._id,
		modelVersion: version,
		modelPath,
		isShadow,
		status: 'running',
		triggeredBy: ctx.triggeredBy ?? 'auto-on-capture',
		triggeredAt,
		confidenceThreshold
	});

	try {
		const result = await runInference(ctx.imageUrl, modelPath, confidenceThreshold);
		await CvInspection.updateOne(
			{ _id: inspectionId },
			{ $set: {
				status: 'completed',
				result: result.result,
				confidenceScore: result.confidence,
				anomalyScore: result.anomaly_score,
				defects: result.defects ?? [],
				processingTimeMs: result.processing_time_ms,
				completedAt: new Date()
			}}
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await CvInspection.updateOne(
			{ _id: inspectionId },
			{ $set: {
				status: 'failed',
				errorMessage: msg,
				completedAt: new Date()
			}}
		);
		console.error(`[phase-inference] project=${project._id} version=${version} image=${ctx.imageId}:`, msg);
	}
}

export async function runInferenceForProject(ctx: InferenceContext, project: any): Promise<void> {
	if (!project.activeModelVersion) return; // nothing to run

	const activeModel = (project.trainedModels ?? []).find((m: any) => m.version === project.activeModelVersion);
	if (!activeModel) {
		console.error(`[phase-inference] project=${project._id} activeModelVersion=${project.activeModelVersion} not found in trainedModels`);
		return;
	}

	const threshold = activeModel.confidenceThreshold ?? 0.5;

	// Active inference
	await runOne(ctx, project, activeModel.version, activeModel.modelPath, threshold, false);

	// Shadow inference (if configured)
	if (project.shadowModelVersion && project.shadowModelVersion !== project.activeModelVersion) {
		const shadowModel = (project.trainedModels ?? []).find((m: any) => m.version === project.shadowModelVersion);
		if (shadowModel) {
			const shadowThreshold = shadowModel.confidenceThreshold ?? 0.5;
			await runOne(ctx, project, shadowModel.version, shadowModel.modelPath, shadowThreshold, true);
		}
	}
}

export async function runPhaseInference(ctx: InferenceContext): Promise<void> {
	const projects = await CvProject.find({
		deployAtPhases: ctx.phase,
		activeModelVersion: { $ne: null }
	}).lean() as any[];

	if (projects.length === 0) return;

	// Run inferences in parallel — they're independent.
	await Promise.all(projects.map(p => runInferenceForProject(ctx, p)));
}
