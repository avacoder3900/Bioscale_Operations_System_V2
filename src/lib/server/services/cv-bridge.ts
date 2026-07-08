/**
 * CV operations bridge — used to call an external Python worker over HTTP,
 * now runs entirely in-process via cv-classifier. Vercel-friendly: no
 * outside service required.
 *
 * Public surface kept stable so existing API routes only need their bodies
 * rewritten, not their imports.
 *
 * CV-PIPELINE-V2 Stage 3/4: training is versioned. Each run appends an
 * immutable entry to project.trainedModels[] (weights + exact training-set
 * manifest + holdout verification) and never overwrites a previous version.
 */
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import {
	embedImage,
	fetchImageBytes,
	fitClassifier,
	predict,
	EMBEDDING_VERSION,
	EMBEDDING_DIM,
	type Classifier
} from './cv-classifier.js';

// Stratified holdout sizing (Stage 4 verify): reserve ~20% per class, aiming
// for at least 5 per class, while always leaving at least 1 image per class
// for the fit. Small classes take what they can — the verify gate then fails
// on minHoldoutCount, which is the intended behavior.
const HOLDOUT_FRACTION = 0.2;
const HOLDOUT_TARGET_PER_CLASS = 5;

// Per-project verifyGate defaults (mirrored in the cv-project schema).
const DEFAULT_MIN_HOLDOUT_COUNT = 10;
const DEFAULT_MIN_BALANCED_ACCURACY = 0.8;

export interface TrainingVerification {
	holdoutImageIds: string[];
	holdoutCount: number;
	accuracy: number;
	balancedAccuracy: number; // mean of per-class recall
	passRecall: number;
	failRecall: number;
	gate: { minHoldoutCount: number; minBalancedAccuracy: number };
	passed: boolean;
	verifiedAt: Date;
}

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
	// Versioned-training additions (CV-PIPELINE-V2)
	version: string;
	versionStatus: 'trained' | 'verified';
	trainingSetCount: number;
	newSincePrevious: number;
	verification: TrainingVerification;
	durationMs: number;
}

interface Operator {
	_id: string;
	username: string;
}

/** Fisher–Yates shuffle on a copy — split randomness for the holdout. */
function shuffled<T>(arr: T[]): T[] {
	const out = [...arr];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** Split one class into holdout + train per the sizing rules above. */
function splitHoldout<T>(cls: T[]): { train: T[]; holdout: T[] } {
	const pool = shuffled(cls);
	const desired = Math.max(1, Math.ceil(pool.length * HOLDOUT_FRACTION), HOLDOUT_TARGET_PER_CLASS);
	const take = Math.min(desired, Math.max(pool.length - 1, 0)); // leave ≥1 for the fit
	return { holdout: pool.slice(0, take), train: pool.slice(take) };
}

/**
 * Train the project's classifier in-process (versioned — Stage 3/4).
 *  - Assembles the training set from CvImages with a `qcLabel` (the single
 *    labeling source of truth; the legacy `label` field is retired), scoped
 *    to the project's phases unless it is the master model, then filtered by
 *    project.trainingFilter (cartridge statuses + required/excluded tags).
 *  - Embeds any image that doesn't already have an `embedding` of the
 *    current EMBEDDING_VERSION, persisting the vector back to Mongo.
 *  - Reserves a stratified holdout the fit never sees, fits a
 *    logistic-regression classifier on the rest, then scores the holdout
 *    against project.verifyGate.
 *  - APPENDS an immutable trainedModels[] entry (weights live inside the
 *    version) and mirrors modelStatus/modelVersion on the project. Existing
 *    entries are never overwritten or deleted.
 */
export async function triggerTraining(
	projectId: string,
	trainedBy?: Operator
): Promise<TrainingResult> {
	const t0 = Date.now();
	const project = (await CvProject.findById(projectId).lean()) as any;
	if (!project) throw new Error(`Project ${projectId} not found`);

	try {
		return await trainProject(project, trainedBy, t0);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await CvProject.updateOne(
			{ _id: projectId },
			{ $set: { modelStatus: 'failed', trainingError: msg } }
		);
		throw err;
	}
}

async function trainProject(project: any, trainedBy: Operator | undefined, t0: number): Promise<TrainingResult> {
	const projectId = project._id as string;

	// --- Training-set assembly (Stage 3) -----------------------------------
	// qcLabel is the only label field the trainer reads. Phase scoping: unless
	// this is the master model, only images captured at one of the project's
	// phases are eligible (no phase filter when the project declares none).
	const query: Record<string, any> = { qcLabel: { $ne: null } };
	const phases: string[] = project.isMasterModel ? [] : (project.phases ?? []);
	if (phases.length > 0) query['cartridgeTag.phase'] = { $in: phases };
	// View scope (CV-PIPELINE-V2 top/bottom split): when the project pins a
	// view, train ONLY on images tagged that exact view. Untagged photos are
	// excluded, since mixing unknown views is what this feature prevents.
	// Applies even to master models. null view = "any view" (no restriction).
	const view: string | null = project.view ?? null;
	if (view) query.view = view;

	// embedding is select:false on the schema — pull it explicitly.
	const images = (await CvImage.find(query)
		.select('_id imageUrl qcLabel cartridgeTag embeddingVersion +embedding')
		.lean()) as any[];

	// trainingFilter: required/excluded failure tags live on cartridgeTag.labels.
	const tf = project.trainingFilter ?? {};
	const requiredTags: string[] = tf.requiredTags ?? [];
	const excludeTags: string[] = tf.excludeTags ?? [];
	let eligible = images;
	if (requiredTags.length > 0) {
		eligible = eligible.filter((img) => {
			const labels: string[] = img.cartridgeTag?.labels ?? [];
			return requiredTags.every((t) => labels.includes(t));
		});
	}
	if (excludeTags.length > 0) {
		eligible = eligible.filter((img) => {
			const labels: string[] = img.cartridgeTag?.labels ?? [];
			return !excludeTags.some((t) => labels.includes(t));
		});
	}

	// trainingFilter.cartridgeStatuses: join against cartridge_records so e.g.
	// voided/scrapped carts can be excluded from the pool.
	const cartridgeStatuses: string[] = tf.cartridgeStatuses ?? [];
	if (cartridgeStatuses.length > 0) {
		const cartIds = [
			...new Set(eligible.map((i) => i.cartridgeTag?.cartridgeRecordId).filter(Boolean))
		];
		const carts = (await CartridgeRecord.find({ _id: { $in: cartIds } })
			.select('_id status')
			.lean()) as any[];
		const allowed = new Set(
			carts.filter((c) => cartridgeStatuses.includes(c.status)).map((c) => c._id)
		);
		eligible = eligible.filter(
			(i) => i.cartridgeTag?.cartridgeRecordId && allowed.has(i.cartridgeTag.cartridgeRecordId)
		);
	}

	// --- Guardrails ---------------------------------------------------------
	if (eligible.length < 5) {
		throw new Error(`Need at least 5 labeled images to train (have ${eligible.length})`);
	}
	const approvedImgs = eligible.filter((i) => i.qcLabel === 'approved');
	const rejectedImgs = eligible.filter((i) => i.qcLabel === 'rejected');
	if (approvedImgs.length === 0 || rejectedImgs.length === 0) {
		throw new Error(
			`Need both classes labeled (have ${approvedImgs.length} approved, ${rejectedImgs.length} rejected). Label at least one of each.`
		);
	}

	// --- Embeddings (cached per EMBEDDING_VERSION) --------------------------
	let embeddedNow = 0;
	const embByImage = new Map<string, number[]>();
	for (const img of eligible) {
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
		embByImage.set(img._id, emb);
	}

	// --- Stratified holdout + fit (Stage 4 verify happens at train time) ----
	const approvedSplit = splitHoldout(approvedImgs);
	const rejectedSplit = splitHoldout(rejectedImgs);
	const trainImgs = [...approvedSplit.train, ...rejectedSplit.train];
	const holdoutImgs = [...approvedSplit.holdout, ...rejectedSplit.holdout];

	const X: number[][] = [];
	const y: number[] = [];
	for (const img of trainImgs) {
		X.push(embByImage.get(img._id)!);
		y.push(img.qcLabel === 'approved' ? 1 : 0);
	}
	const classifier = fitClassifier(X, y);

	// Evaluate the candidate on the holdout the fit never saw.
	const confidenceThreshold = project.confidenceThreshold ?? 0.5;
	let passCorrect = 0;
	let passTotal = 0;
	let failCorrect = 0;
	let failTotal = 0;
	for (const img of holdoutImgs) {
		const out = predict(embByImage.get(img._id)!, classifier, confidenceThreshold);
		if (img.qcLabel === 'approved') {
			passTotal++;
			if (out.verdict === 'pass') passCorrect++;
		} else {
			failTotal++;
			if (out.verdict === 'fail') failCorrect++;
		}
	}
	const holdoutCount = holdoutImgs.length;
	const accuracy = holdoutCount > 0 ? (passCorrect + failCorrect) / holdoutCount : 0;
	// A class absent from the holdout scores 0 recall — an unsound holdout
	// should fail the gate, not sneak past it.
	const passRecall = passTotal > 0 ? passCorrect / passTotal : 0;
	const failRecall = failTotal > 0 ? failCorrect / failTotal : 0;
	const balancedAccuracy = (passRecall + failRecall) / 2;

	const gate = {
		minHoldoutCount: project.verifyGate?.minHoldoutCount ?? DEFAULT_MIN_HOLDOUT_COUNT,
		minBalancedAccuracy: project.verifyGate?.minBalancedAccuracy ?? DEFAULT_MIN_BALANCED_ACCURACY
	};
	const passed = holdoutCount >= gate.minHoldoutCount && balancedAccuracy >= gate.minBalancedAccuracy;

	const verification: TrainingVerification = {
		holdoutImageIds: holdoutImgs.map((i) => i._id),
		holdoutCount,
		accuracy,
		balancedAccuracy,
		passRecall,
		failRecall,
		gate,
		passed,
		verifiedAt: new Date()
	};

	// --- Versioned output (Stage 3): APPEND, never overwrite ----------------
	const existing: any[] = project.trainedModels ?? [];
	const version = `v${existing.length + 1}-lr-${EMBEDDING_VERSION}-${Date.now()}`;
	const previous = existing.length > 0 ? existing[existing.length - 1] : null;
	const previousIds = new Set<string>(previous?.trainingSet?.imageIds ?? []);
	const trainImageIds = trainImgs.map((i) => i._id);
	const newSincePrevious = trainImageIds.filter((id) => !previousIds.has(id)).length;
	const versionStatus: 'trained' | 'verified' = passed ? 'verified' : 'trained';

	const entry = {
		version,
		status: versionStatus,
		classifier,
		confidenceThreshold,
		trainedAt: new Date(),
		...(trainedBy ? { trainedBy } : {}),
		trainingSet: {
			imageIds: trainImageIds, // exactly what the fit saw; holdout ids live in verification
			count: trainImgs.length,
			approvedCount: classifier.approvedCount,
			rejectedCount: classifier.rejectedCount,
			newSincePrevious,
			filter: { phases, view, cartridgeStatuses, requiredTags, excludeTags }
		},
		verification
	};

	await CvProject.updateOne(
		{ _id: projectId },
		{
			$push: { trainedModels: entry },
			// Convenience mirrors of the latest entry — nothing more.
			$set: {
				modelStatus: 'trained',
				modelVersion: version,
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
		modelVersion: version,
		version,
		versionStatus,
		trainingSetCount: trainImgs.length,
		newSincePrevious,
		verification,
		durationMs: Date.now() - t0
	};
}

export async function getTrainingStatus(projectId: string) {
	const project = (await CvProject.findById(projectId)
		.select('modelStatus modelVersion classifier trainingError trainedModels')
		.lean()) as any;
	if (!project) throw new Error(`Project ${projectId} not found`);
	// Prefer the latest trainedModels entry; fall back to the legacy
	// project-level classifier for pre-versioning projects.
	const versions: any[] = project.trainedModels ?? [];
	const latest = versions.length > 0 ? versions[versions.length - 1] : null;
	const classifier = latest?.classifier ?? project.classifier;
	return {
		project_id: projectId,
		status: project.modelStatus ?? 'untrained',
		modelVersion: latest?.version ?? project.modelVersion ?? null,
		samplesUsed: classifier?.samplesUsed ?? 0,
		approvedCount: classifier?.approvedCount ?? 0,
		rejectedCount: classifier?.rejectedCount ?? 0,
		trainingAccuracy: classifier?.trainingAccuracy ?? null,
		trainedAt: classifier?.trainedAt ?? null,
		message: project.trainingError ?? ''
	};
}

export interface InferenceResult {
	result: 'pass' | 'fail';
	confidence: number;
	percentConfidence: number;
	passProbability: number;
	threshold: number;
	modelVersion: string | null;
	processing_time_ms: number;
	defects: Array<{ type: string; location: string; severity: string }>;
}

/**
 * Run inference on a single image using one of the project's trained models.
 *
 * @param imageUrl  Public URL or R2 path of the image.
 * @param projectId Project whose classifier should grade the image. (Earlier
 *                  signature took a model path — we now pull weights from
 *                  the project doc, so the param is the project id.)
 * @param confidenceThreshold Optional override of the version's threshold.
 * @param versionOverride Optional trainedModels version to grade with —
 *                  shadow runs pass shadowModelVersion here. Defaults to
 *                  activeModelVersion, then the latest trained version. The
 *                  legacy project-level classifier is only used when the
 *                  project has no trainedModels entries at all.
 */
export async function runInference(
	imageUrl: string,
	projectId: string,
	confidenceThreshold?: number,
	versionOverride?: string
): Promise<InferenceResult> {
	const t0 = Date.now();
	const project = (await CvProject.findById(projectId)
		.select('classifier confidenceThreshold modelStatus trainedModels activeModelVersion')
		.lean()) as any;
	if (!project) throw new Error(`Project ${projectId} not found`);

	const versions: any[] = project.trainedModels ?? [];
	let classifier: Classifier;
	let modelVersion: string | null = null;
	let versionThreshold: number | undefined;

	if (versions.length > 0) {
		const wanted = versionOverride ?? project.activeModelVersion;
		const entry = wanted
			? versions.find((m) => m.version === wanted)
			: versions[versions.length - 1]; // nothing deployed — grade with the latest version
		if (!entry) {
			throw new Error(`Project ${projectId} has no trained model version '${wanted}'`);
		}
		if (!entry.classifier?.weights?.length) {
			throw new Error(`Model version ${entry.version} of project ${projectId} has no classifier weights`);
		}
		classifier = entry.classifier as Classifier;
		modelVersion = entry.version;
		versionThreshold = entry.confidenceThreshold;
	} else {
		// Legacy fallback: projects trained before versioning kept weights at
		// the project level.
		if (project.modelStatus !== 'trained' || !project.classifier?.weights?.length) {
			throw new Error(`Project ${projectId} has no trained classifier`);
		}
		classifier = project.classifier as Classifier;
		modelVersion = project.modelVersion ?? null;
	}

	if (classifier.embeddingDim !== EMBEDDING_DIM) {
		throw new Error(
			`Classifier embedding dim ${classifier.embeddingDim} != worker dim ${EMBEDDING_DIM}. Retrain.`
		);
	}

	const bytes = await fetchImageBytes(imageUrl);
	const embedding = await embedImage(bytes);
	const threshold =
		typeof confidenceThreshold === 'number'
			? confidenceThreshold
			: (versionThreshold ?? project.confidenceThreshold ?? 0.5);
	const out = predict(embedding, classifier, threshold);

	return {
		result: out.verdict,
		confidence: out.percentConfidence / 100,
		percentConfidence: out.percentConfidence,
		passProbability: out.passProbability,
		threshold,
		modelVersion,
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
