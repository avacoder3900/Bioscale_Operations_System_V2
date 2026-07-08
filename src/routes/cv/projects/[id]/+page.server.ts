/**
 * /cv/projects/[id] — project detail with tabs:
 *   - Members:     view/add/remove member imageIds
 *   - Composition: composedOf + isLiveComposition
 *   - Training:    training-scope setup — phases, master toggle, verify-gate
 *                  overrides, trainingFilter (statuses/tags).
 *   - Deployment:  deploy-at phases + per-version Deploy / Roll back / Verify /
 *                  Shadow (CV-PIPELINE-V2 Stage 4 — the verify → deploy gate).
 *   - History:     train button (with pre-train pool visibility) + per-version
 *                  scorecard + recent inspections.
 */
import { error, fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import {
	embedImage,
	fetchImageBytes,
	predict,
	EMBEDDING_VERSION
} from '$lib/server/services/cv-classifier';
import { getR2Url } from '$lib/server/services/r2';
import type { Actions, PageServerLoad } from './$types';

const PREVIEW_LIMIT = 60;

// Verify-gate defaults (mirrored in the cv-project schema + cv-bridge).
const DEFAULT_MIN_HOLDOUT_COUNT = 10;
const DEFAULT_MIN_BALANCED_ACCURACY = 0.8;

// Canonical manufacturing phases — the exact set enumerated by the capture and
// inspect flows (/capture DEFAULT_PHASES + the phase-pinned wax-inspect
// ('wax_filled') and post-mortem-inspect ('post_mortem') pages). Do not invent
// new phase names here.
const CANONICAL_PHASES = [
	'wax_filled',
	'reagent_filled',
	'inspected',
	'sealed',
	'oven_cured',
	'qaqc_released',
	'post_run',
	'post_mortem'
];

/** Real cartridge_records.status enum, read off the schema (single source of truth). */
function cartridgeStatusValues(): string[] {
	const path = CartridgeRecord.schema.path('status') as any;
	return (path?.enumValues ?? []) as string[];
}

/** Parse a comma-separated tag input into a clean string array. */
function parseTagList(raw: string | undefined | null): string[] {
	return (raw ?? '')
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);
}

/** Strip the heavy classifier blob before shipping a version to the client. */
function toClientVersion(m: any) {
	const ts = m.trainingSet ?? null;
	const v = m.verification ?? null;
	return {
		version: m.version,
		status: m.status ?? 'trained',
		confidenceThreshold: m.confidenceThreshold ?? null,
		trainedAt: m.trainedAt ?? null,
		trainedBy: m.trainedBy ? { username: m.trainedBy.username ?? null } : null,
		deployedAt: m.deployedAt ?? null,
		deployedBy:
			m.deployedBy && typeof m.deployedBy === 'object'
				? { username: m.deployedBy.username ?? null }
				: null,
		legacy: !!m.legacy,
		trainingSet: ts
			? {
					count: ts.count ?? null,
					approvedCount: ts.approvedCount ?? null,
					rejectedCount: ts.rejectedCount ?? null,
					newSincePrevious: ts.newSincePrevious ?? null,
					imageCount: Array.isArray(ts.imageIds) ? ts.imageIds.length : (ts.count ?? null)
				}
			: null,
		verification: v
			? {
					holdoutCount: v.holdoutCount ?? null,
					accuracy: v.accuracy ?? null,
					balancedAccuracy: v.balancedAccuracy ?? null,
					passRecall: v.passRecall ?? null,
					failRecall: v.failRecall ?? null,
					gate: v.gate ?? null,
					passed: !!v.passed,
					mode: v.mode ?? null,
					verifiedAt: v.verifiedAt ?? null,
					verifiedBy: v.verifiedBy ? { username: v.verifiedBy.username ?? null } : null
				}
			: null
	};
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const project = await CvProject.findById(params.id).lean() as any;
	if (!project) throw error(404, 'Project not found');

	const memberIds: string[] = project.members ?? [];

	// Resolve live composition (one level deep — siblings flatten their own members).
	let liveAdditions: string[] = [];
	if (project.isLiveComposition && (project.composedOf ?? []).length > 0) {
		const children = await CvProject.find({ _id: { $in: project.composedOf } })
			.select('members')
			.lean() as any[];
		const set = new Set<string>(memberIds);
		for (const c of children) {
			for (const m of c.members ?? []) {
				if (!set.has(m)) {
					set.add(m);
					liveAdditions.push(m);
				}
			}
		}
	}

	const effectiveIds = [...memberIds, ...liveAdditions];
	const totalEffective = effectiveIds.length;

	// Preview slice (first N for the Members tab)
	const previewIds = effectiveIds.slice(0, PREVIEW_LIMIT);
	const previewImages = previewIds.length > 0
		? await CvImage.find({ _id: { $in: previewIds } })
			.select('_id cartridgeImageNumber cartridgeTag filePath imageUrl thumbnailPath qcLabel capturedAt')
			.lean()
		: [];

	// Stats: how many of the effective set are labeled
	const labelCounts = effectiveIds.length > 0
		? await CvImage.aggregate([
			{ $match: { _id: { $in: effectiveIds } } },
			{ $group: { _id: '$qcLabel', count: { $sum: 1 } } }
		])
		: [];
	const labelMap = new Map<string | null, number>();
	for (const r of labelCounts as any[]) labelMap.set(r._id, r.count);

	// Other projects (for composition picker)
	const otherProjects = await CvProject.find({ _id: { $ne: params.id } })
		.select('_id name members composedOf')
		.lean() as any[];

	// Recent inspections produced by this project's models
	const recentInspections = await CvInspection.find({ projectId: params.id })
		.sort({ triggeredAt: -1 })
		.limit(20)
		.lean();

	// Per-version scorecard (Stage 5): model verdict vs. human review agreement,
	// grouped by the version that produced the verdict.
	const scorecardRaw = await CvInspection.aggregate([
		{ $match: { projectId: params.id, result: { $in: ['pass', 'fail'] } } },
		{
			$group: {
				_id: '$modelVersion',
				totalRuns: { $sum: 1 },
				shadowRuns: { $sum: { $cond: [{ $eq: ['$isShadow', true] }, 1, 0] } },
				reviewed: { $sum: { $cond: [{ $in: ['$humanLabel', ['pass', 'fail']] }, 1, 0] } },
				agreed: {
					$sum: {
						$cond: [
							{ $and: [{ $in: ['$humanLabel', ['pass', 'fail']] }, { $eq: ['$humanLabel', '$result'] }] },
							1,
							0
						]
					}
				}
			}
		},
		{ $sort: { _id: 1 } }
	]);
	const scorecard = (scorecardRaw as any[]).map((s) => ({
		version: s._id ?? '(unversioned)',
		totalRuns: s.totalRuns ?? 0,
		shadowRuns: s.shadowRuns ?? 0,
		reviewed: s.reviewed ?? 0,
		agreed: s.agreed ?? 0,
		agreementPct: s.reviewed > 0 ? Math.round((s.agreed / s.reviewed) * 1000) / 10 : null
	}));

	// Phases observed in the data — drives the deployAtPhases checkboxes
	const observedPhases = await CvImage.distinct('cartridgeTag.phase');

	// --- Pre-train visibility (PRD Stage 3) ---------------------------------
	// Assemble the eligible labeled pool with the SAME rules the trainer uses
	// (cv-bridge trainProject): qcLabel != null, phase scope unless master
	// model, then trainingFilter tags + cartridge statuses. Count-level only —
	// we select just the fields the filters need, never embeddings/pixels.
	const poolQuery: Record<string, any> = { qcLabel: { $ne: null } };
	const scopePhases: string[] = project.isMasterModel ? [] : (project.phases ?? []);
	if (scopePhases.length > 0) poolQuery['cartridgeTag.phase'] = { $in: scopePhases };

	let pool = await CvImage.find(poolQuery)
		.select('_id qcLabel cartridgeTag.labels cartridgeTag.cartridgeRecordId')
		.lean() as any[];

	const tf = project.trainingFilter ?? {};
	const poolRequiredTags: string[] = tf.requiredTags ?? [];
	const poolExcludeTags: string[] = tf.excludeTags ?? [];
	if (poolRequiredTags.length > 0) {
		pool = pool.filter((img) => {
			const labels: string[] = img.cartridgeTag?.labels ?? [];
			return poolRequiredTags.every((t) => labels.includes(t));
		});
	}
	if (poolExcludeTags.length > 0) {
		pool = pool.filter((img) => {
			const labels: string[] = img.cartridgeTag?.labels ?? [];
			return !poolExcludeTags.some((t) => labels.includes(t));
		});
	}
	const poolStatuses: string[] = tf.cartridgeStatuses ?? [];
	if (poolStatuses.length > 0) {
		const cartIds = [
			...new Set(pool.map((i) => i.cartridgeTag?.cartridgeRecordId).filter(Boolean))
		];
		const carts = await CartridgeRecord.find({ _id: { $in: cartIds } })
			.select('_id status')
			.lean() as any[];
		const allowed = new Set(
			carts.filter((c) => poolStatuses.includes(c.status)).map((c) => c._id)
		);
		pool = pool.filter(
			(i) => i.cartridgeTag?.cartridgeRecordId && allowed.has(i.cartridgeTag.cartridgeRecordId)
		);
	}

	// Diff against the latest version's manifest: "M new since <current version>".
	const trainedModelsArr: any[] = project.trainedModels ?? [];
	const latestModel = trainedModelsArr.length > 0 ? trainedModelsArr[trainedModelsArr.length - 1] : null;
	const lastManifest = new Set<string>(latestModel?.trainingSet?.imageIds ?? []);
	const trainPool = {
		approved: pool.filter((i) => i.qcLabel === 'approved').length,
		rejected: pool.filter((i) => i.qcLabel === 'rejected').length,
		total: pool.length,
		newSinceLastVersion: latestModel ? pool.filter((i) => !lastManifest.has(i._id)).length : pool.length,
		latestVersion: latestModel?.version ?? null
	};

	// Phase checkbox options for the Training tab: the canonical set, plus any
	// legacy value already on the project so it stays visible/uncheckable-aware.
	const canonicalPhases = Array.from(
		new Set([...CANONICAL_PHASES, ...(project.phases ?? [])])
	);

	return {
		project: {
			id: project._id,
			name: project.name ?? '',
			description: project.description ?? '',
			purpose: project.purpose ?? '',
			tags: project.tags ?? [],
			members: memberIds,
			memberCount: memberIds.length,
			composedOf: project.composedOf ?? [],
			isLiveComposition: !!project.isLiveComposition,
			isMasterModel: !!project.isMasterModel,
			phases: project.phases ?? [],
			trainingFilter: {
				cartridgeStatuses: project.trainingFilter?.cartridgeStatuses ?? [],
				requiredTags: project.trainingFilter?.requiredTags ?? [],
				excludeTags: project.trainingFilter?.excludeTags ?? []
			},
			deployAtPhases: project.deployAtPhases ?? [],
			activeModelVersion: project.activeModelVersion ?? null,
			shadowModelVersion: project.shadowModelVersion ?? null,
			verifyGate: {
				minHoldoutCount: project.verifyGate?.minHoldoutCount ?? DEFAULT_MIN_HOLDOUT_COUNT,
				minBalancedAccuracy: project.verifyGate?.minBalancedAccuracy ?? DEFAULT_MIN_BALANCED_ACCURACY
			},
			trainedModels: (project.trainedModels ?? []).map(toClientVersion),
			createdAt: project.createdAt ?? null,
			updatedAt: project.updatedAt ?? null
		},
		effectiveTotal: totalEffective,
		liveAdditionCount: liveAdditions.length,
		previewImages: (previewImages as any[]).map(img => ({
			id: img._id,
			cartridgeImageNumber: img.cartridgeImageNumber ?? null,
			cartridgeRecordId: img.cartridgeTag?.cartridgeRecordId ?? null,
			phase: img.cartridgeTag?.phase ?? null,
			qcLabel: img.qcLabel ?? null,
			thumbnailUrl: img.thumbnailPath ? getR2Url(img.thumbnailPath) : (img.imageUrl || (img.filePath ? getR2Url(img.filePath) : null)),
			capturedAt: img.capturedAt ?? null
		})),
		labelStats: {
			approved: labelMap.get('approved') ?? 0,
			rejected: labelMap.get('rejected') ?? 0,
			unlabeled: labelMap.get(null) ?? 0
		},
		otherProjects: otherProjects.map(p => ({
			id: p._id,
			name: p.name ?? '',
			memberCount: (p.members ?? []).length
		})),
		recentInspections: JSON.parse(JSON.stringify(recentInspections)),
		scorecard,
		observedPhases: (observedPhases as string[]).filter(Boolean).sort(),
		canonicalPhases,
		cartridgeStatusOptions: cartridgeStatusValues(),
		trainPool
	};
};

export const actions: Actions = {
	updateMetadata: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();
		const update: Record<string, any> = {
			name: form.get('name')?.toString().trim(),
			description: form.get('description')?.toString() ?? '',
			purpose: form.get('purpose')?.toString() ?? ''
		};
		if (!update.name) return fail(400, { error: 'Name is required' });
		await CvProject.updateOne({ _id: params.id }, { $set: update });
		return { success: true, section: 'metadata' };
	},

	removeMember: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();
		const imageId = form.get('imageId')?.toString();
		if (!imageId) return fail(400, { error: 'imageId required' });
		await CvProject.updateOne({ _id: params.id }, { $pull: { members: imageId } });
		return { success: true, section: 'members' };
	},

	updateComposition: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();
		const composedOf = form.getAll('composedOf').map(v => String(v)).filter(Boolean);
		const isLiveComposition = form.get('isLiveComposition') === 'on';

		// Cycle guard: project can't compose itself.
		if (composedOf.includes(params.id)) {
			return fail(400, { error: 'Project cannot include itself in composedOf' });
		}

		await CvProject.updateOne(
			{ _id: params.id },
			{ $set: { composedOf, isLiveComposition } }
		);
		return { success: true, section: 'composition' };
	},

	// Training-scope settings (PRD Stage 3): phase scope, master toggle,
	// verify-gate overrides, trainingFilter. Writes ONLY fields declared on the
	// cv-project schema, via dotted $set so trainingFilter.phases (unused by the
	// trainer but declared) is never clobbered.
	updateTrainingSetup: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();

		const existing = await CvProject.findById(params.id)
			.select('phases trainingFilter verifyGate isMasterModel')
			.lean() as any;
		if (!existing) return fail(404, { error: 'Project not found' });

		const isMasterModel = form.get('isMasterModel') === 'on';

		// Phase scope: canonical set + any legacy value already on the project.
		const allowedPhases = new Set([...CANONICAL_PHASES, ...(existing.phases ?? [])]);
		const submittedPhases = form.getAll('phases').map((v) => String(v)).filter(Boolean);
		const badPhase = submittedPhases.find((p) => !allowedPhases.has(p));
		if (badPhase) return fail(400, { error: `Unknown phase: ${badPhase}`, section: 'training-setup' });

		// Verify gate (defaults 10 / 0.80).
		const minHoldoutCount = Number(form.get('minHoldoutCount') ?? DEFAULT_MIN_HOLDOUT_COUNT);
		const minBalancedAccuracy = Number(form.get('minBalancedAccuracy') ?? DEFAULT_MIN_BALANCED_ACCURACY);
		if (!Number.isInteger(minHoldoutCount) || minHoldoutCount < 1) {
			return fail(400, { error: 'Min holdout count must be an integer ≥ 1.', section: 'training-setup' });
		}
		if (!Number.isFinite(minBalancedAccuracy) || minBalancedAccuracy <= 0 || minBalancedAccuracy > 1) {
			return fail(400, { error: 'Min balanced accuracy must be in (0, 1].', section: 'training-setup' });
		}

		// trainingFilter: statuses restricted to the real cartridge status enum.
		const validStatuses = new Set(cartridgeStatusValues());
		const cartridgeStatuses = form.getAll('cartridgeStatuses').map((v) => String(v)).filter(Boolean);
		const badStatus = cartridgeStatuses.find((s) => !validStatuses.has(s));
		if (badStatus) return fail(400, { error: `Unknown cartridge status: ${badStatus}`, section: 'training-setup' });
		const requiredTags = parseTagList(form.get('requiredTags')?.toString());
		const excludeTags = parseTagList(form.get('excludeTags')?.toString());

		const set: Record<string, any> = {
			isMasterModel,
			'verifyGate.minHoldoutCount': minHoldoutCount,
			'verifyGate.minBalancedAccuracy': minBalancedAccuracy,
			'trainingFilter.cartridgeStatuses': cartridgeStatuses,
			'trainingFilter.requiredTags': requiredTags,
			'trainingFilter.excludeTags': excludeTags
		};
		// Master-model projects skip the phase filter — their checkboxes post
		// disabled/empty, so leave phases untouched rather than wiping them.
		if (!isMasterModel) set.phases = submittedPhases;

		await CvProject.updateOne({ _id: params.id }, { $set: set });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cv_projects',
			recordId: params.id,
			action: 'cv_training_setup',
			oldData: {
				phases: existing.phases ?? [],
				isMasterModel: !!existing.isMasterModel,
				verifyGate: existing.verifyGate ?? null,
				trainingFilter: existing.trainingFilter ?? null
			},
			newData: {
				phases: isMasterModel ? (existing.phases ?? []) : submittedPhases,
				isMasterModel,
				verifyGate: { minHoldoutCount, minBalancedAccuracy },
				trainingFilter: { cartridgeStatuses, requiredTags, excludeTags }
			},
			changedAt: new Date(),
			changedBy: locals.user.username ?? locals.user._id,
			reason: 'cv_training_setup: training scope / gate / filter updated'
		});

		return { success: true, section: 'training-setup', message: 'Training setup saved.' };
	},

	// Manual override of the routing fields (advanced). The primary path is the
	// per-version deployVersion action below; this stays for direct edits.
	updateDeployment: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();
		const deployAtPhases = form.getAll('phase').map(v => String(v)).filter(Boolean);
		const activeModelVersion = form.get('activeModelVersion')?.toString() || null;
		const shadowModelVersion = form.get('shadowModelVersion')?.toString() || null;

		const project = await CvProject.findById(params.id).select('trainedModels').lean() as any;
		if (!project) return fail(404, { error: 'Project not found' });

		const knownVersions = new Set((project.trainedModels ?? []).map((m: any) => m.version));
		if (activeModelVersion && !knownVersions.has(activeModelVersion)) {
			return fail(400, { error: `Unknown active version: ${activeModelVersion}` });
		}
		if (shadowModelVersion && !knownVersions.has(shadowModelVersion)) {
			return fail(400, { error: `Unknown shadow version: ${shadowModelVersion}` });
		}

		await CvProject.updateOne(
			{ _id: params.id },
			{ $set: { deployAtPhases, activeModelVersion, shadowModelVersion } }
		);
		return { success: true, section: 'deployment' };
	},

	// Promote a verified version to the deployed model (Stage 4). Rollback is the
	// same call against an older passed version. Re-checks the gate server-side,
	// flips lifecycle status, retires the previously deployed version, and points
	// activeModelVersion + deployAtPhases at the chosen version.
	deployVersion: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();
		const version = form.get('version')?.toString();
		const phases = form.getAll('phase').map(v => String(v)).filter(Boolean);
		if (!version) return fail(400, { error: 'version required' });

		const project = await CvProject.findById(params.id)
			.select('trainedModels deployAtPhases')
			.lean() as any;
		if (!project) return fail(404, { error: 'Project not found' });

		const entry = (project.trainedModels ?? []).find((m: any) => m.version === version);
		if (!entry) return fail(400, { error: `Unknown version: ${version}` });
		// Server-side gate re-check — never trust the button's enabled state.
		if (!entry.verification?.passed) {
			return fail(400, {
				error: `Version ${version} has not passed verification and cannot be deployed.`,
				section: 'deployment'
			});
		}

		// Keep the current routing phases when the form posts none.
		const deployAtPhases = phases.length > 0 ? phases : (project.deployAtPhases ?? []);
		const now = new Date();
		const deployer = { _id: locals.user._id, username: locals.user.username };

		await CvProject.updateOne(
			{ _id: params.id },
			{
				$set: {
					activeModelVersion: version,
					deployAtPhases,
					modelVersion: version,
					modelStatus: 'trained',
					'trainedModels.$[elem].status': 'deployed',
					'trainedModels.$[elem].deployedAt': now,
					'trainedModels.$[elem].deployedBy': deployer,
					// Retire whatever was deployed before (status only — weights kept).
					'trainedModels.$[dep].status': 'retired'
				}
			},
			{
				arrayFilters: [
					{ 'elem.version': version },
					{ 'dep.status': 'deployed', 'dep.version': { $ne: version } }
				]
			}
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cv_projects',
			recordId: params.id,
			action: 'cv_deploy',
			newData: { version, phases: deployAtPhases },
			changedAt: now,
			changedBy: locals.user.username ?? locals.user._id,
			reason: `cv_deploy ${version} at ${deployAtPhases.join(', ') || '(no phases)'}`
		});

		return {
			success: true,
			section: 'deployment',
			message: `Deployed ${version} at ${deployAtPhases.join(', ') || '(no phases)'}.`
		};
	},

	// Re-score a version against the CURRENT labeled pool (Stage 4 "quick check").
	// Prefers images the version never trained on (a fresh holdout); falls back to
	// the full pool if that leaves a class empty. Updates ONLY that version's
	// verification via a positional array update — never rewrites the array.
	verifyVersion: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();
		const version = form.get('version')?.toString();
		if (!version) return fail(400, { error: 'version required' });

		const project = await CvProject.findById(params.id)
			.select('trainedModels phases isMasterModel trainingFilter verifyGate confidenceThreshold')
			.lean() as any;
		if (!project) return fail(404, { error: 'Project not found' });

		const entry = (project.trainedModels ?? []).find((m: any) => m.version === version);
		if (!entry) return fail(400, { error: `Unknown version: ${version}` });
		const classifier = entry.classifier;
		if (!classifier?.weights?.length) {
			return fail(400, { error: `Version ${version} has no classifier weights to score.`, section: 'deployment' });
		}

		try {
			// Assemble the eligible labeled pool with the trainer's rules (phase
			// scope unless master model, then trainingFilter tags + statuses).
			const query: Record<string, any> = { qcLabel: { $ne: null } };
			const phases: string[] = project.isMasterModel ? [] : (project.phases ?? []);
			if (phases.length > 0) query['cartridgeTag.phase'] = { $in: phases };

			let pool = await CvImage.find(query)
				.select('_id imageUrl qcLabel cartridgeTag embeddingVersion +embedding')
				.lean() as any[];

			const tf = project.trainingFilter ?? {};
			const requiredTags: string[] = tf.requiredTags ?? [];
			const excludeTags: string[] = tf.excludeTags ?? [];
			if (requiredTags.length > 0) {
				pool = pool.filter((img) => {
					const labels: string[] = img.cartridgeTag?.labels ?? [];
					return requiredTags.every((t) => labels.includes(t));
				});
			}
			if (excludeTags.length > 0) {
				pool = pool.filter((img) => {
					const labels: string[] = img.cartridgeTag?.labels ?? [];
					return !excludeTags.some((t) => labels.includes(t));
				});
			}
			const cartridgeStatuses: string[] = tf.cartridgeStatuses ?? [];
			if (cartridgeStatuses.length > 0) {
				const cartIds = [
					...new Set(pool.map((i) => i.cartridgeTag?.cartridgeRecordId).filter(Boolean))
				];
				const carts = await CartridgeRecord.find({ _id: { $in: cartIds } })
					.select('_id status')
					.lean() as any[];
				const allowed = new Set(
					carts.filter((c) => cartridgeStatuses.includes(c.status)).map((c) => c._id)
				);
				pool = pool.filter(
					(i) => i.cartridgeTag?.cartridgeRecordId && allowed.has(i.cartridgeTag.cartridgeRecordId)
				);
			}

			// Prefer a fresh holdout (images the fit never saw) when it still has
			// both classes; otherwise score the whole pool and say so.
			const trainedIds = new Set<string>(entry.trainingSet?.imageIds ?? []);
			const fresh = pool.filter((i) => !trainedIds.has(i._id));
			const freshHasBoth =
				fresh.some((i) => i.qcLabel === 'approved') && fresh.some((i) => i.qcLabel === 'rejected');
			const useFresh = fresh.length > 0 && freshHasBoth;
			const scoringSet = useFresh ? fresh : pool;
			const mode = useFresh ? 'holdout-excludes-training' : 'full-pool';

			if (scoringSet.length === 0) {
				return fail(400, { error: 'No labeled images available to verify against.', section: 'deployment' });
			}

			const threshold = entry.confidenceThreshold ?? project.confidenceThreshold ?? 0.5;
			let passCorrect = 0;
			let passTotal = 0;
			let failCorrect = 0;
			let failTotal = 0;
			const scoredIds: string[] = [];
			for (const img of scoringSet) {
				let emb: number[] | undefined =
					img.embeddingVersion === EMBEDDING_VERSION && Array.isArray(img.embedding)
						? img.embedding
						: undefined;
				if (!emb) {
					if (!img.imageUrl) continue; // can't score an image with no pixels
					const bytes = await fetchImageBytes(img.imageUrl);
					emb = await embedImage(bytes);
					await CvImage.updateOne(
						{ _id: img._id },
						{ $set: { embedding: emb, embeddingVersion: EMBEDDING_VERSION } }
					);
				}
				const out = predict(emb, classifier as any, threshold);
				scoredIds.push(img._id);
				if (img.qcLabel === 'approved') {
					passTotal++;
					if (out.verdict === 'pass') passCorrect++;
				} else {
					failTotal++;
					if (out.verdict === 'fail') failCorrect++;
				}
			}

			const holdoutCount = scoredIds.length;
			const accuracy = holdoutCount > 0 ? (passCorrect + failCorrect) / holdoutCount : 0;
			const passRecall = passTotal > 0 ? passCorrect / passTotal : 0;
			const failRecall = failTotal > 0 ? failCorrect / failTotal : 0;
			const balancedAccuracy = (passRecall + failRecall) / 2;
			const gate = {
				minHoldoutCount: project.verifyGate?.minHoldoutCount ?? DEFAULT_MIN_HOLDOUT_COUNT,
				minBalancedAccuracy: project.verifyGate?.minBalancedAccuracy ?? DEFAULT_MIN_BALANCED_ACCURACY
			};
			const passed = holdoutCount >= gate.minHoldoutCount && balancedAccuracy >= gate.minBalancedAccuracy;
			const now = new Date();
			const verifier = { _id: locals.user._id, username: locals.user.username };

			const verification = {
				holdoutImageIds: scoredIds,
				holdoutCount,
				accuracy,
				balancedAccuracy,
				passRecall,
				failRecall,
				gate,
				passed,
				mode, // which pool this on-demand check scored against
				verifiedAt: now,
				verifiedBy: verifier
			};

			// Positional update of just this entry. Don't move a deployed/retired
			// version's lifecycle status — only flip trained<->verified for
			// not-yet-deployed versions.
			const set: Record<string, any> = { 'trainedModels.$[elem].verification': verification };
			if (entry.status === 'trained' || entry.status === 'verified') {
				set['trainedModels.$[elem].status'] = passed ? 'verified' : 'trained';
			}
			await CvProject.updateOne(
				{ _id: params.id },
				{ $set: set },
				{ arrayFilters: [{ 'elem.version': version }] }
			);

			await AuditLog.create({
				_id: generateId(),
				tableName: 'cv_projects',
				recordId: params.id,
				action: 'cv_verify',
				newData: { version, holdoutCount, balancedAccuracy, passed, mode },
				changedAt: now,
				changedBy: locals.user.username ?? locals.user._id,
				reason: `cv_verify ${version}: balAcc ${(balancedAccuracy * 100).toFixed(1)}% on ${holdoutCount} (${mode}) -> ${passed ? 'PASS' : 'FAIL'}`
			});

			return {
				success: true,
				section: 'deployment',
				message: `Verified ${version}: balanced accuracy ${(balancedAccuracy * 100).toFixed(1)}% on ${holdoutCount} images (${mode}) — ${passed ? 'passed' : 'did not pass'} the gate.`
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return fail(500, { error: `Verify failed: ${msg}`, section: 'deployment' });
		}
	},

	setShadow: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		const form = await request.formData();
		const version = form.get('version')?.toString();
		if (!version) return fail(400, { error: 'version required' });
		const project = await CvProject.findById(params.id).select('trainedModels').lean() as any;
		if (!project) return fail(404, { error: 'Project not found' });
		if (!(project.trainedModels ?? []).some((m: any) => m.version === version)) {
			return fail(400, { error: `Unknown version: ${version}` });
		}
		await CvProject.updateOne({ _id: params.id }, { $set: { shadowModelVersion: version } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'cv_projects',
			recordId: params.id,
			action: 'cv_shadow_set',
			newData: { shadowModelVersion: version },
			changedAt: new Date(),
			changedBy: locals.user.username ?? locals.user._id,
			reason: `cv_shadow_set ${version}`
		});
		return { success: true, section: 'deployment', message: `Shadow set to ${version}.` };
	},

	clearShadow: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		await CvProject.updateOne({ _id: params.id }, { $set: { shadowModelVersion: null } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'cv_projects',
			recordId: params.id,
			action: 'cv_shadow_clear',
			newData: { shadowModelVersion: null },
			changedAt: new Date(),
			changedBy: locals.user.username ?? locals.user._id,
			reason: 'cv_shadow_clear'
		});
		return { success: true, section: 'deployment' };
	},

	deleteProject: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();
		await CvProject.findByIdAndDelete(params.id);
		redirect(303, '/cv/projects');
	},

	train: async ({ params, locals, fetch, request }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		const form = await request.formData();
		const rawThreshold = form.get('confidenceThreshold')?.toString();
		const confidenceThreshold = rawThreshold ? Number(rawThreshold) : undefined;

		const resp = await fetch('/api/cv/train', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ projectId: params.id, confidenceThreshold })
		});
		const body = await resp.json().catch(() => ({}));
		if (!resp.ok) {
			return fail(resp.status, {
				error: body?.error ?? `Training failed (HTTP ${resp.status})`,
				section: 'train'
			});
		}

		// Training now runs synchronously in-process and returns the new version +
		// its holdout verification (nested under `data`). Surface the gate result.
		const d = body.data ?? {};
		const v = d.verification ?? {};
		const balAcc = typeof v.balancedAccuracy === 'number' ? `${(v.balancedAccuracy * 100).toFixed(1)}%` : '—';
		const gateMsg = d.gatePassed ? 'passed the verify gate' : 'did not pass the verify gate';
		const nextStep = d.gatePassed
			? 'Deploy it under the Deployment tab.'
			: 'Label more images and retrain, or lower the gate.';
		return {
			success: true,
			section: 'train',
			message: `Trained ${d.version} — ${d.samplesUsed ?? '?'} samples (${d.approvedCount ?? '?'}✓ / ${d.rejectedCount ?? '?'}✗), ${d.newSincePrevious ?? 0} new since the previous version. Holdout balanced accuracy ${balAcc} on ${v.holdoutCount ?? '?'} images — ${gateMsg}. ${nextStep}`
		};
	}
};

export const config = { maxDuration: 60 };
