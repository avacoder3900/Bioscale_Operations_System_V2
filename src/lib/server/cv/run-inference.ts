/**
 * Auto-on-capture inference orchestration.
 *
 * - `runInferenceForProject` — grades one image with one project's trained
 *   in-process classifier and records a CvInspection. Fire-and-forget; errors
 *   are caught and logged, never thrown back to the caller.
 * - `runPhaseInference` — given a captured image's phase, runs every trained
 *   project deployed at that phase.
 *
 * NOTE: inference runs in-process via cv-bridge.runInference (logistic
 * regression on image embeddings). There is no external worker. CvInspection
 * is written with ONLY schema-declared fields and valid status enums
 * ('processing' -> 'complete'/'failed') — Mongoose strict mode drops anything
 * else, which is what silently broke the previous PaDiM-era version of this file.
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

export async function runInferenceForProject(ctx: InferenceContext, project: any): Promise<void> {
	// Only trained projects with a persisted classifier can grade an image.
	if (project.modelStatus !== 'trained' || !project.classifier?.weights?.length) return;

	const inspectionId = generateId();
	const threshold = project.confidenceThreshold ?? 0.5;

	// Insert a processing record up front so the wax-inspect poll (which watches
	// /api/cv/inspections?imageId=) sees the inspection immediately.
	await CvInspection.create({
		_id: inspectionId,
		imageId: ctx.imageId,
		cartridgeRecordId: ctx.cartridgeRecordId,
		phase: ctx.phase,
		projectId: project._id,
		inspectionType: project.projectType,
		modelVersion: project.modelVersion,
		status: 'processing'
	});

	try {
		const result = await runInference(ctx.imageUrl, project._id, threshold);
		await CvInspection.updateOne(
			{ _id: inspectionId },
			{ $set: {
				status: 'complete',
				result: result.result,
				confidenceScore: result.confidence,
				defects: result.defects ?? [],
				processingTimeMs: result.processing_time_ms,
				completedAt: new Date()
			} }
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await CvInspection.updateOne(
			{ _id: inspectionId },
			{ $set: { status: 'failed', completedAt: new Date() } }
		);
		console.error(`[phase-inference] project=${project._id} image=${ctx.imageId}:`, msg);
	}
}

export async function runPhaseInference(ctx: InferenceContext): Promise<void> {
	const projects = await CvProject.find({
		deployAtPhases: ctx.phase,
		modelStatus: 'trained'
	}).lean() as any[];

	if (projects.length === 0) return;

	// Independent — run in parallel.
	await Promise.all(projects.map((p) => runInferenceForProject(ctx, p)));
}
