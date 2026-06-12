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

interface ValidatedInferenceResponse {
	result: 'pass' | 'fail';
	confidence?: number;
	anomaly_score?: number;
	raw_score?: number;
	processing_time_ms?: number;
	defects: unknown[];
}

/**
 * Hand-rolled validation of the worker /infer response (no zod in this repo).
 * Returns the typed response or an error string describing the first violation.
 */
function validateInferenceResponse(raw: unknown): { ok: true; value: ValidatedInferenceResponse } | { ok: false; error: string } {
	if (typeof raw !== 'object' || raw === null) {
		return { ok: false, error: `worker response is not an object (got ${raw === null ? 'null' : typeof raw})` };
	}
	const r = raw as Record<string, unknown>;

	if (r.result !== 'pass' && r.result !== 'fail') {
		return { ok: false, error: `worker response field 'result' must be 'pass' or 'fail' (got ${JSON.stringify(r.result)})` };
	}

	const numericWhenPresent = ['confidence', 'anomaly_score', 'raw_score', 'processing_time_ms'] as const;
	for (const field of numericWhenPresent) {
		const v = r[field];
		if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isFinite(v))) {
			return { ok: false, error: `worker response field '${field}' must be a finite number when present (got ${JSON.stringify(v)})` };
		}
	}

	if (r.defects !== undefined && r.defects !== null && !Array.isArray(r.defects)) {
		return { ok: false, error: `worker response field 'defects' must be an array when present (got ${typeof r.defects})` };
	}

	return {
		ok: true,
		value: {
			result: r.result,
			confidence: (r.confidence ?? undefined) as number | undefined,
			anomaly_score: (r.anomaly_score ?? undefined) as number | undefined,
			raw_score: (r.raw_score ?? undefined) as number | undefined,
			processing_time_ms: (r.processing_time_ms ?? undefined) as number | undefined,
			defects: Array.isArray(r.defects) ? r.defects : []
		}
	};
}

/** Min-max normalization params from a trainedModels[] entry, if usable. */
function extractScoreStats(modelEntry: any): { rawMin: number; rawMax: number } | undefined {
	const s = modelEntry?.scoreStats;
	if (!s) return undefined;
	if (typeof s.rawMin !== 'number' || typeof s.rawMax !== 'number') return undefined;
	if (!Number.isFinite(s.rawMin) || !Number.isFinite(s.rawMax)) return undefined;
	return { rawMin: s.rawMin, rawMax: s.rawMax };
}

/**
 * Effective inference threshold per the calibration PRD:
 * operator override ?? calibrated ?? legacy 0.5.
 */
function effectiveThreshold(modelEntry: any): number {
	return modelEntry?.confidenceThreshold ?? modelEntry?.calibratedThreshold ?? 0.5;
}

async function runOne(
	ctx: InferenceContext,
	project: any,
	modelEntry: any,
	isShadow: boolean
): Promise<void> {
	const inspectionId = generateId();
	const triggeredAt = new Date();
	const threshold = effectiveThreshold(modelEntry);
	const scoreStats = extractScoreStats(modelEntry);
	const version = modelEntry.version;
	const modelPath = modelEntry.modelPath;

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
		confidenceThreshold: threshold
	});

	try {
		const raw = await runInference(ctx.imageUrl, modelPath, threshold, scoreStats);
		const validated = validateInferenceResponse(raw);
		if (!validated.ok) {
			await CvInspection.updateOne(
				{ _id: inspectionId },
				{ $set: {
					status: 'failed',
					errorMessage: `Invalid worker response: ${validated.error}`,
					completedAt: new Date()
				}}
			);
			console.error(`[phase-inference] project=${project._id} version=${version} image=${ctx.imageId}: invalid worker response: ${validated.error}`);
			return;
		}

		const result = validated.value;
		await CvInspection.updateOne(
			{ _id: inspectionId },
			{ $set: {
				status: 'completed',
				result: result.result,
				confidenceScore: result.confidence,
				rawScore: result.raw_score,
				anomalyScore: result.anomaly_score, // normalized score (back-compat field)
				defects: result.defects,
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

	// Active inference
	await runOne(ctx, project, activeModel, false);

	// Shadow inference (if configured)
	if (project.shadowModelVersion && project.shadowModelVersion !== project.activeModelVersion) {
		const shadowModel = (project.trainedModels ?? []).find((m: any) => m.version === project.shadowModelVersion);
		if (shadowModel) {
			await runOne(ctx, project, shadowModel, true);
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
