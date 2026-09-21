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
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { generateId } from '$lib/server/db/utils.js';
import { runInference } from '$lib/server/services/cv-bridge';

interface InferenceContext {
	imageId: string;
	imageUrl: string;
	cartridgeRecordId: string;
	phase: string;
	// Camera view of the captured photo (CV-PIPELINE-V2 top/bottom split).
	// null/undefined = untagged photo — graded only by view-less projects.
	view?: string | null;
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

	// Insert a queued record up front so the operator can see the inspection
	// is in progress, even if inference is slow. Lifecycle matches the
	// cv-inspection status enum: queued -> running -> completed | failed.
	await CvInspection.create({
		_id: inspectionId,
		imageId: ctx.imageId,
		cartridgeRecordId: ctx.cartridgeRecordId,
		phase: ctx.phase,
		projectId: project._id,
		modelVersion: version,
		modelPath,
		isShadow,
		status: 'queued',
		triggeredBy: ctx.triggeredBy ?? 'auto-on-capture',
		triggeredAt,
		confidenceThreshold
	});

	try {
		await CvInspection.updateOne({ _id: inspectionId }, { $set: { status: 'running' } });

		// runInference expects the PROJECT ID (it re-fetches the project to load
		// the trained weights). The version is passed as an override so each run
		// grades with ITS OWN weights — shadow runs use shadowModelVersion, not
		// whatever happens to be active.
		const result = await runInference(ctx.imageUrl, project._id, confidenceThreshold, version);
		await CvInspection.updateOne(
			{ _id: inspectionId },
			{ $set: {
				status: 'completed',
				result: result.result,
				confidenceScore: result.confidence,
				defects: result.defects ?? [],
				processingTimeMs: result.processing_time_ms,
				completedAt: new Date()
			}}
		);

		// Mirror a compact verdict summary onto the cartridge's photos[] entry
		// (CV-PIPELINE-V2 Stage 5) — active runs only; shadows stay invisible.
		// Summary only: labels/embeddings/history never move onto the cartridge.
		// A mirror failure must not flip a completed inspection to failed.
		if (!isShadow) {
			try {
				await CartridgeRecord.updateOne(
					{ _id: ctx.cartridgeRecordId, 'photos.imageId': ctx.imageId },
					{ $set: {
						'photos.$.verdictSummary': {
							verdict: result.result,
							inspectionId,
							modelVersion: version,
							at: new Date()
						}
					}}
				);
			} catch (mirrorErr) {
				const mirrorMsg = mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr);
				console.error(`[phase-inference] verdict mirror failed cartridge=${ctx.cartridgeRecordId} image=${ctx.imageId}:`, mirrorMsg);
			}
		}
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

	// Shadow inference (if configured) — runs with the shadow version's weights.
	if (project.shadowModelVersion && project.shadowModelVersion !== project.activeModelVersion) {
		const shadowModel = (project.trainedModels ?? []).find((m: any) => m.version === project.shadowModelVersion);
		if (shadowModel) {
			const shadowThreshold = shadowModel.confidenceThreshold ?? 0.5;
			await runOne(ctx, project, shadowModel.version, shadowModel.modelPath, shadowThreshold, true);
		}
	}
}

/**
 * Phases where auto-on-capture inference is switched OFF for now — captures
 * at these phases save the photo and nothing else (no CvInspection, no
 * model verdict), even if a CvProject deploys there.
 *
 * reagent_filled: per Jacob 2026-08-19 — the Reagent Inspect page should
 * just capture the picture; CV rejection of reagent carts is not wanted yet.
 * Remove the phase from this set to turn inference back on.
 */
export const INFERENCE_DISABLED_PHASES: ReadonlySet<string> = new Set(['reagent_filled']);

export function isInferenceDisabledForPhase(phase: string | null | undefined): boolean {
	return !!phase && INFERENCE_DISABLED_PHASES.has(phase);
}

export async function runPhaseInference(ctx: InferenceContext): Promise<void> {
	if (isInferenceDisabledForPhase(ctx.phase)) return;

	const projects = await CvProject.find({
		deployAtPhases: ctx.phase,
		activeModelVersion: { $ne: null }
	}).lean() as any[];

	if (projects.length === 0) return;

	// View gate (CV-PIPELINE-V2 top/bottom split): a photo with a set view is
	// only graded by view-less projects (view null = "any view") or projects
	// pinned to that exact view; a photo with null view is only graded by
	// view-less projects. A view-scoped project never grades the wrong view.
	const photoView = ctx.view ?? null;
	const eligible = projects.filter(p => {
		const projView = p.view ?? null;
		return projView === null || projView === photoView;
	});

	if (eligible.length === 0) return;

	// Run inferences in parallel — they're independent.
	await Promise.all(eligible.map(p => runInferenceForProject(ctx, p)));
}
