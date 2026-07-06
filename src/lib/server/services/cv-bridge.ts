/**
 * CV train/infer orchestration — runs entirely in-process (sharp + logistic
 * regression), Vercel-friendly, no external service.
 *
 * The dedicated data pathway:
 *   cartridge_records.photos[] (human qcLabel = truth)
 *     → triggerTraining (embed via cv_images cache, fit LR, holdout eval)
 *     → CvProject.trainedModels[] + activeModelVersion
 *     → runInference on new captures
 *     → cv_inspections (machine verdicts only).
 *
 * Photos and their labels are NEVER read from cv_images — that collection is
 * only the embedding/technical cache, keyed by photos[].imageId.
 */
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import {
	embedImage,
	fetchImageBytes,
	fitClassifier,
	predict,
	EMBEDDING_VERSION,
	type Classifier
} from './cv-classifier.js';

interface OperatorRef {
	_id: string;
	username: string;
}

interface LabeledPhoto {
	imageId: string;
	cartridgeRecordId: string;
	phase: string;
	r2Url: string;
	qcLabel: 'approved' | 'rejected';
}

export interface TrainingResult {
	projectId: string;
	status: 'trained' | 'failed';
	modelVersion: string;
	samplesUsed: number;
	approvedCount: number;
	rejectedCount: number;
	trainingAccuracy: number;
	trainingLogLoss: number;
	holdoutAccuracy: number | null;
	holdoutF1: number | null;
	holdoutSamples: number;
	embeddedNow: number;
	durationMs: number;
}

/**
 * The training set for a project: every photo on any cartridge whose phase is
 * in the project's phases and whose human qcLabel is set.
 */
export async function listLabeledPhotos(phases: string[]): Promise<LabeledPhoto[]> {
	return CartridgeRecord.aggregate([
		{ $match: { 'photos.qcLabel': { $in: ['approved', 'rejected'] } } },
		{ $unwind: '$photos' },
		{
			$match: {
				'photos.phase': { $in: phases },
				'photos.qcLabel': { $in: ['approved', 'rejected'] }
			}
		},
		{
			$project: {
				_id: 0,
				imageId: '$photos.imageId',
				cartridgeRecordId: '$_id',
				phase: '$photos.phase',
				r2Url: '$photos.r2Url',
				qcLabel: '$photos.qcLabel'
			}
		}
	]);
}

/**
 * Embedding for one photo, via the cv_images cache. Stale/missing entries are
 * recomputed from the R2 image and persisted back.
 */
async function getEmbedding(photo: LabeledPhoto): Promise<{ embedding: number[]; computed: boolean }> {
	const cached = (await CvImage.findById(photo.imageId)
		.select('embedding embeddingVersion')
		.lean()) as any;

	if (cached?.embeddingVersion === EMBEDDING_VERSION && Array.isArray(cached.embedding) && cached.embedding.length) {
		return { embedding: cached.embedding, computed: false };
	}

	if (!photo.r2Url) {
		throw new Error(`Photo ${photo.imageId} has no r2Url, cannot embed`);
	}
	const bytes = await fetchImageBytes(photo.r2Url);
	const embedding = await embedImage(bytes);
	await CvImage.updateOne(
		{ _id: photo.imageId },
		{
			$set: {
				cartridgeRecordId: photo.cartridgeRecordId,
				phase: photo.phase,
				embedding,
				embeddingVersion: EMBEDDING_VERSION,
				embeddedAt: new Date()
			}
		},
		{ upsert: true }
	);
	return { embedding, computed: true };
}

/**
 * Deterministic stratified split: within each class (sorted by imageId so
 * reruns produce the same split), every 5th sample goes to the holdout.
 * Skipped entirely below 10 labeled photos — too small to spare any.
 */
function splitHoldout(items: Array<{ x: number[]; y: number; imageId: string }>) {
	if (items.length < 10) return { train: items, holdout: [] as typeof items };
	const train: typeof items = [];
	const holdout: typeof items = [];
	for (const cls of [0, 1]) {
		const ofClass = items.filter((i) => i.y === cls).sort((a, b) => a.imageId.localeCompare(b.imageId));
		ofClass.forEach((item, idx) => {
			if (idx % 5 === 4) holdout.push(item);
			else train.push(item);
		});
	}
	return { train, holdout };
}

/** Holdout accuracy + F1 for the 'rejected' class (the one that matters for QC). */
function evaluate(classifier: Classifier, holdout: Array<{ x: number[]; y: number }>, threshold: number) {
	let correct = 0;
	let tp = 0, fp = 0, fn = 0;
	for (const { x, y } of holdout) {
		const out = predict(x, classifier, threshold);
		const predicted = out.verdict === 'pass' ? 1 : 0;
		if (predicted === y) correct++;
		// 'rejected' (y=0) is the positive class for F1.
		if (predicted === 0 && y === 0) tp++;
		if (predicted === 0 && y === 1) fp++;
		if (predicted === 1 && y === 0) fn++;
	}
	const accuracy = correct / holdout.length;
	const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
	const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
	const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
	return { accuracy, f1 };
}

/**
 * Train the project's classifier in-process from cartridge photo truth.
 * Appends a new trainedModels[] entry and activates it. Older versions stay
 * on the project for rollback (activate via the project PATCH endpoint).
 */
export async function triggerTraining(projectId: string, trainedBy?: OperatorRef): Promise<TrainingResult> {
	const t0 = Date.now();
	const project = (await CvProject.findById(projectId).lean()) as any;
	if (!project) throw new Error(`Project ${projectId} not found`);
	if (!project.phases?.length) {
		throw new Error(`Project ${projectId} has no phases — set phases[] to define its training/deployment scope`);
	}

	await CvProject.updateOne({ _id: projectId }, { $set: { modelStatus: 'training', trainingError: null } });

	try {
		const photos = await listLabeledPhotos(project.phases);
		if (photos.length < 5) {
			throw new Error(`Need at least 5 labeled photos to train (have ${photos.length})`);
		}
		const approvedCount = photos.filter((p) => p.qcLabel === 'approved').length;
		const rejectedCount = photos.length - approvedCount;
		if (approvedCount === 0 || rejectedCount === 0) {
			throw new Error(
				`Need both classes labeled (have ${approvedCount} approved, ${rejectedCount} rejected). Label at least one of each.`
			);
		}

		let embeddedNow = 0;
		const items: Array<{ x: number[]; y: number; imageId: string }> = [];
		for (const photo of photos) {
			const { embedding, computed } = await getEmbedding(photo);
			if (computed) embeddedNow++;
			items.push({ x: embedding, y: photo.qcLabel === 'approved' ? 1 : 0, imageId: photo.imageId });
		}

		const { train, holdout } = splitHoldout(items);
		const classifier = fitClassifier(train.map((i) => i.x), train.map((i) => i.y));

		const threshold = project.confidenceThreshold ?? 0.5;
		const holdoutMetrics = holdout.length ? evaluate(classifier, holdout, threshold) : null;

		const modelVersion = `lr-${EMBEDDING_VERSION}-${Date.now()}`;
		const modelEntry = {
			version: modelVersion,
			trainedAt: new Date(),
			...(trainedBy ? { trainedBy } : {}),
			classifier: {
				weights: classifier.weights,
				bias: classifier.bias,
				featureMeans: classifier.featureMeans,
				featureStds: classifier.featureStds,
				calibrationMin: classifier.calibrationMin,
				calibrationMax: classifier.calibrationMax,
				embeddingDim: classifier.embeddingDim,
				embeddingVersion: classifier.embeddingVersion
			},
			samplesUsed: items.length,
			approvedCount,
			rejectedCount,
			trainingAccuracy: classifier.trainingAccuracy,
			trainingLogLoss: classifier.trainingLogLoss,
			holdoutAccuracy: holdoutMetrics?.accuracy ?? null,
			holdoutF1: holdoutMetrics?.f1 ?? null,
			holdoutSamples: holdout.length,
			confidenceThreshold: threshold
		};

		await CvProject.updateOne(
			{ _id: projectId },
			{
				$push: { trainedModels: modelEntry },
				$set: {
					modelStatus: 'trained',
					activeModelVersion: modelVersion,
					trainingError: null
				}
			}
		);

		return {
			projectId,
			status: 'trained',
			modelVersion,
			samplesUsed: items.length,
			approvedCount,
			rejectedCount,
			trainingAccuracy: classifier.trainingAccuracy,
			trainingLogLoss: classifier.trainingLogLoss,
			holdoutAccuracy: holdoutMetrics?.accuracy ?? null,
			holdoutF1: holdoutMetrics?.f1 ?? null,
			holdoutSamples: holdout.length,
			embeddedNow,
			durationMs: Date.now() - t0
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await CvProject.updateOne(
			{ _id: projectId },
			{ $set: { modelStatus: 'failed', trainingError: msg } }
		);
		throw err;
	}
}

export async function getTrainingStatus(projectId: string) {
	const project = (await CvProject.findById(projectId)
		.select('modelStatus activeModelVersion trainedModels trainingError')
		.lean()) as any;
	if (!project) throw new Error(`Project ${projectId} not found`);
	const active = (project.trainedModels ?? []).find((m: any) => m.version === project.activeModelVersion);
	return {
		project_id: projectId,
		status: project.modelStatus ?? 'untrained',
		modelVersion: project.activeModelVersion ?? null,
		samplesUsed: active?.samplesUsed ?? 0,
		approvedCount: active?.approvedCount ?? 0,
		rejectedCount: active?.rejectedCount ?? 0,
		trainingAccuracy: active?.trainingAccuracy ?? null,
		holdoutAccuracy: active?.holdoutAccuracy ?? null,
		holdoutF1: active?.holdoutF1 ?? null,
		trainedAt: active?.trainedAt ?? null,
		message: project.trainingError ?? ''
	};
}

export interface InferenceResult {
	result: 'pass' | 'fail';
	confidence: number;
	percentConfidence: number;
	passProbability: number;
	threshold: number;
	modelVersion: string;
	processing_time_ms: number;
}

/**
 * Grade one image with a project's trained model.
 *
 * @param modelVersion which trainedModels[] entry to use; defaults to the
 *                     project's activeModelVersion (pass the shadow version
 *                     explicitly for shadow runs).
 */
export async function runInference(
	imageUrl: string,
	projectId: string,
	opts: { modelVersion?: string; confidenceThreshold?: number } = {}
): Promise<InferenceResult> {
	const t0 = Date.now();
	const project = (await CvProject.findById(projectId)
		.select('trainedModels activeModelVersion confidenceThreshold modelStatus')
		.lean()) as any;
	if (!project) throw new Error(`Project ${projectId} not found`);

	const version = opts.modelVersion ?? project.activeModelVersion;
	if (!version) throw new Error(`Project ${projectId} has no active model — train first`);
	const model = (project.trainedModels ?? []).find((m: any) => m.version === version);
	if (!model?.classifier?.weights?.length) {
		throw new Error(`Project ${projectId} model version ${version} not found or has no weights`);
	}
	if (model.classifier.embeddingVersion !== EMBEDDING_VERSION) {
		throw new Error(
			`Model ${version} was trained on embedding ${model.classifier.embeddingVersion}, current is ${EMBEDDING_VERSION}. Retrain.`
		);
	}

	const bytes = await fetchImageBytes(imageUrl);
	const embedding = await embedImage(bytes);
	const threshold =
		opts.confidenceThreshold ??
		model.confidenceThreshold ??
		project.confidenceThreshold ??
		0.5;
	const out = predict(embedding, model.classifier as Classifier, threshold);

	return {
		result: out.verdict,
		confidence: out.percentConfidence / 100,
		percentConfidence: out.percentConfidence,
		passProbability: out.passProbability,
		threshold,
		modelVersion: version,
		processing_time_ms: Date.now() - t0
	};
}
