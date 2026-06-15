/**
 * CV operations bridge — used to call an external Python worker over HTTP,
 * now runs entirely in-process via cv-classifier. Vercel-friendly: no
 * outside service required.
 *
 * Public surface kept stable so existing API routes only need their bodies
 * rewritten, not their imports.
 */
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import {
	embedImage,
	fetchImageBytes,
	fitClassifier,
	predict,
	EMBEDDING_VERSION,
	EMBEDDING_DIM,
	type Classifier
} from './cv-classifier.js';

export interface TrainingResult {
	projectId: string;
	status: 'trained' | 'failed';
	samplesUsed: number;
	approvedCount: number;
	rejectedCount: number;
	trainingAccuracy: number;
	trainingLogLoss: number;
	embeddedNow: number;
	modelVersion: string;
	durationMs: number;
}

/**
 * Train the project's classifier in-process.
 *  - Pulls every labeled CvImage for the project (or every labeled image if
 *    the project is the master model).
 *  - Embeds any image that doesn't already have an `embedding` of the
 *    current EMBEDDING_VERSION, persisting the vector back to Mongo.
 *  - Fits a logistic-regression classifier on (embedding, label) pairs.
 *  - Saves classifier weights + meta to project.classifier.
 */
export async function triggerTraining(projectId: string): Promise<TrainingResult> {
	const t0 = Date.now();
	const project = (await CvProject.findById(projectId).lean()) as any;
	if (!project) throw new Error(`Project ${projectId} not found`);

	// Labels are stored on CvImage.qcLabel (legacy docs used .label). Membership:
	// a master model trains on every labeled image; otherwise the project trains
	// on labeled images captured at one of its deployAtPhases. (Images carry no
	// projectId on this schema, so phase is the association.)
	const labelExpr = { $in: ['approved', 'rejected'] };
	const query: Record<string, any> = { $or: [{ qcLabel: labelExpr }, { label: labelExpr }] };
	if (!project.isMasterModel) {
		const phases: string[] = project.deployAtPhases ?? [];
		if (phases.length === 0) {
			throw new Error('Project is not a master model and has no deployAtPhases — nothing to train on.');
		}
		query['cartridgeTag.phase'] = { $in: phases };
	}

	const images = (await CvImage.find(query)
		.select('_id imageUrl filePath qcLabel label embedding embeddingVersion')
		.lean()) as any[];

	const labelOf = (i: any): string | null => i.qcLabel ?? i.label ?? null;

	if (images.length < 5) {
		throw new Error(`Need at least 5 labeled images to train (have ${images.length})`);
	}
	const approved = images.filter((i) => labelOf(i) === 'approved').length;
	const rejected = images.filter((i) => labelOf(i) === 'rejected').length;
	if (approved === 0 || rejected === 0) {
		throw new Error(
			`Need both classes labeled (have ${approved} approved, ${rejected} rejected). Label at least one of each.`
		);
	}

	let embeddedNow = 0;
	const X: number[][] = [];
	const y: number[] = [];

	for (const img of images) {
		let emb: number[] | undefined =
			img.embeddingVersion === EMBEDDING_VERSION && Array.isArray(img.embedding)
				? img.embedding
				: undefined;

		if (!emb) {
			const url = img.imageUrl;
			if (!url) {
				throw new Error(`CvImage ${img._id} has no imageUrl, cannot embed`);
			}
			const bytes = await fetchImageBytes(url);
			emb = await embedImage(bytes);
			await CvImage.updateOne(
				{ _id: img._id },
				{ $set: { embedding: emb, embeddingVersion: EMBEDDING_VERSION } }
			);
			embeddedNow++;
		}

		X.push(emb);
		y.push(labelOf(img) === 'approved' ? 1 : 0);
	}

	const classifier = fitClassifier(X, y);
	const modelVersion = `lr-${EMBEDDING_VERSION}-${Date.now()}`;

	await CvProject.updateOne(
		{ _id: projectId },
		{
			$set: {
				classifier,
				modelStatus: 'trained',
				modelVersion,
				trainingError: null
			}
		}
	);

	return {
		projectId,
		status: 'trained',
		samplesUsed: classifier.samplesUsed,
		approvedCount: classifier.approvedCount,
		rejectedCount: classifier.rejectedCount,
		trainingAccuracy: classifier.trainingAccuracy,
		trainingLogLoss: classifier.trainingLogLoss,
		embeddedNow,
		modelVersion,
		durationMs: Date.now() - t0
	};
}

export async function getTrainingStatus(projectId: string) {
	const project = (await CvProject.findById(projectId)
		.select('modelStatus modelVersion classifier trainingError')
		.lean()) as any;
	if (!project) throw new Error(`Project ${projectId} not found`);
	return {
		project_id: projectId,
		status: project.modelStatus ?? 'untrained',
		modelVersion: project.modelVersion ?? null,
		samplesUsed: project.classifier?.samplesUsed ?? 0,
		approvedCount: project.classifier?.approvedCount ?? 0,
		rejectedCount: project.classifier?.rejectedCount ?? 0,
		trainingAccuracy: project.classifier?.trainingAccuracy ?? null,
		trainedAt: project.classifier?.trainedAt ?? null,
		message: project.trainingError ?? ''
	};
}

export interface InferenceResult {
	result: 'pass' | 'fail';
	confidence: number;
	percentConfidence: number;
	passProbability: number;
	threshold: number;
	processing_time_ms: number;
	defects: Array<{ type: string; location: string; severity: string }>;
}

/**
 * Run inference on a single image using the project's trained classifier.
 *
 * @param imageUrl  Public URL or R2 path of the image.
 * @param projectId Project whose classifier should grade the image. (Earlier
 *                  signature took a model path — we now pull weights from
 *                  the project doc, so the param is the project id.)
 * @param confidenceThreshold Optional override of project's threshold.
 */
export async function runInference(
	imageUrl: string,
	projectId: string,
	confidenceThreshold?: number
): Promise<InferenceResult> {
	const t0 = Date.now();
	const project = (await CvProject.findById(projectId)
		.select('classifier confidenceThreshold modelStatus')
		.lean()) as any;
	if (!project) throw new Error(`Project ${projectId} not found`);
	if (project.modelStatus !== 'trained' || !project.classifier?.weights?.length) {
		throw new Error(`Project ${projectId} has no trained classifier`);
	}
	if (project.classifier.embeddingDim !== EMBEDDING_DIM) {
		throw new Error(
			`Classifier embedding dim ${project.classifier.embeddingDim} != worker dim ${EMBEDDING_DIM}. Retrain.`
		);
	}

	const bytes = await fetchImageBytes(imageUrl);
	const embedding = await embedImage(bytes);
	const threshold =
		typeof confidenceThreshold === 'number'
			? confidenceThreshold
			: (project.confidenceThreshold ?? 0.5);
	const out = predict(embedding, project.classifier as Classifier, threshold);

	return {
		result: out.verdict,
		confidence: out.percentConfidence / 100,
		percentConfidence: out.percentConfidence,
		passProbability: out.passProbability,
		threshold,
		processing_time_ms: Date.now() - t0,
		defects:
			out.verdict === 'fail'
				? [{ type: 'classifier_low_confidence', location: 'global', severity: 'high' }]
				: []
	};
}

/**
 * LIZA image processing (color correction + CLAHE + sharpen) was previously
 * implemented in the Python cv-worker. The worker is no longer required for
 * train/infer, but `processImage` is not yet reimplemented in JS.
 */
export async function processImage(
	_imageUrl: string,
	_outputKey: string,
	_mode: 'full' | 'raw' = 'full',
	_params?: Record<string, number>
): Promise<never> {
	throw new Error(
		'processImage (LIZA pipeline) is not implemented in the in-process CV bridge yet. Capture raw images and use the classifier directly, or reimplement LIZA on top of sharp.'
	);
}
