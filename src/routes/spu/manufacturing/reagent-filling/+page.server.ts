import { redirect } from '@sveltejs/kit';
import { connectDB, ReagentBatchRecord, AssayDefinition, CartridgeRecord, WaxFillingRun } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

// Map internal status to display stage
function statusToStage(status: string): string {
	switch (status) {
		case 'setup': return 'Setup';
		case 'running': return 'Running';
		case 'completed': return 'Storage';
		case 'aborted': return 'Setup';
		default: return 'Loading';
	}
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const robotId = url.searchParams.get('robot') ?? '';

	// Find active run for this robot (not finalized, not aborted)
	const activeRun = robotId
		? await ReagentBatchRecord.findOne({
				'robot._id': robotId,
				status: { $in: ['setup', 'running'] },
				finalizedAt: { $exists: false }
			})
				.sort({ createdAt: -1 })
				.lean() as any
		: null;

	const [assayTypes] = await Promise.all([
		AssayDefinition.find({ isActive: true }, { _id: 1, name: 1, skuCode: 1 }).lean()
	]);

	// Determine runState
	const hasActiveRun = !!activeRun;
	const runState = {
		hasActiveRun,
		stage: hasActiveRun ? statusToStage(activeRun.status) : null,
		assayTypeName: activeRun?.assayType?.name ?? null,
		cartridgeCount: activeRun?.cartridgeCount ?? activeRun?.cartridgesFilled?.length ?? 0,
		runStartTime: activeRun?.runStartTime ?? null,
		runEndTime: activeRun?.runEndTime ?? null
	};

	// Get tubes for current run
	const tubes = (activeRun?.tubeRecords ?? []).map((t: any) => ({
		wellPosition: t.wellPosition ?? 0,
		reagentName: t.reagentName ?? '',
		sourceLotId: t.sourceLotId ?? null,
		transferTubeId: t.transferTubeId ?? null,
		preparedAt: t.preparedAt ?? null
	}));

	// Get cartridges for current run
	let cartridges: any[] = [];
	if (activeRun?.cartridgesFilled?.length) {
		const cartridgeIds = activeRun.cartridgesFilled.map((c: any) => c.cartridgeId);
		const cartridgeRecords = await CartridgeRecord.find(
			{ _id: { $in: cartridgeIds } },
			{ _id: 1, currentPhase: 1, 'topSeal.batchId': 1 }
		).lean();
		const crMap = new Map((cartridgeRecords as any[]).map((c: any) => [c._id, c]));

		cartridges = activeRun.cartridgesFilled.map((cf: any) => {
			const cr = crMap.get(cf.cartridgeId);
			return {
				id: cf.cartridgeId,
				deckPosition: cf.deckPosition ?? 0,
				inspectionStatus: cf.inspectionStatus ?? 'Pending',
				inspectionReason: cf.inspectionReason ?? null,
				inspectedAt: cf.inspectedAt ?? null,
				topSealBatchId: cr?.topSeal?.batchId ?? null
			};
		});
	}

	// Current seal batch
	const currentSealBatch = activeRun?.topSeal?.status === 'completed' ? {
		topSealLotId: activeRun.topSeal.topSealLotId ?? null,
		firstScanTime: activeRun.topSeal.firstScanTime ?? null,
		cartridgeCount: activeRun.topSeal.cartridgeCount ?? 0
	} : null;

	// Rejection codes (static list)
	const rejectionCodes = [
		{ code: 'visual_defect', label: 'Visual Defect' },
		{ code: 'fill_error', label: 'Fill Error' },
		{ code: 'contamination', label: 'Contamination' },
		{ code: 'seal_defect', label: 'Seal Defect' },
		{ code: 'other', label: 'Other' }
	];

	// Reagent definitions from active assay
	let reagentDefinitions: string[] = [];
	if (activeRun?.assayType?._id) {
		const assay = await AssayDefinition.findById(activeRun.assayType._id).lean() as any;
		if (assay?.reagents) {
			reagentDefinitions = assay.reagents
				.filter((r: any) => r.isActive !== false)
				.sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
				.map((r: any) => r.reagentName ?? '');
		}
	}

	// Check if robot is blocked by wax filling
	let robotBlocked: { runId: string } | null = null;
	if (robotId) {
		const waxRun = await WaxFillingRun?.findOne?.({
			'robot._id': robotId,
			status: 'running',
			finalizedAt: { $exists: false }
		}).lean() as any;
		if (waxRun) {
			robotBlocked = { runId: waxRun._id };
		}
	}

	return {
		robotId,
		activeRunId: activeRun?._id ?? null,
		runState,
		assayTypes: (assayTypes as any[]).map((a: any) => ({
			id: a._id, name: a.name, skuCode: a.skuCode ?? null
		})),
		reagentDefinitions,
		tubes,
		cartridges,
		rejectionCodes,
		currentSealBatch,
		robotBlocked
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const robotId = data.get('robotId') as string;
		const robotName = data.get('robotName') as string;
		const robotSide = data.get('robotSide') as string;
		const assayTypeId = data.get('assayTypeId') as string;

		let assayRef = null;
		if (assayTypeId) {
			const assay = await AssayDefinition.findById(assayTypeId, { _id: 1, name: 1, skuCode: 1 }).lean() as any;
			if (assay) {
				assayRef = { _id: assay._id, name: assay.name, skuCode: assay.skuCode };
			}
		}

		const run = await ReagentBatchRecord.create({
			robot: { _id: robotId, name: robotName, side: robotSide || undefined },
			assayType: assayRef,
			operator: { _id: locals.user._id, username: locals.user.username },
			status: 'setup',
			tubeRecords: [],
			cartridgesFilled: [],
			setupTimestamp: new Date()
		});

		return { success: true, runId: run._id };
	},

	addTubeRecord: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;

		const tube = {
			wellPosition: Number(data.get('wellPosition')),
			reagentName: data.get('reagentName') as string,
			sourceLotId: (data.get('sourceLotId') as string) || undefined,
			transferTubeId: (data.get('transferTubeId') as string) || undefined,
			preparedAt: new Date()
		};

		await ReagentBatchRecord.findOneAndUpdate(
			{ _id: runId, finalizedAt: { $exists: false } },
			{ $push: { tubeRecords: tube } }
		);
		return { success: true };
	},

	startRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;

		await ReagentBatchRecord.findOneAndUpdate(
			{ _id: runId, finalizedAt: { $exists: false } },
			{ $set: { status: 'running', runStartTime: new Date() } }
		);
		return { success: true };
	},

	completeRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const now = new Date();

		const run = await ReagentBatchRecord.findOneAndUpdate(
			{ _id: runId, finalizedAt: { $exists: false } },
			{ $set: { status: 'completed', runEndTime: now, finalizedAt: now } },
			{ new: true }
		).lean() as any;

		// Write reagentFilling phase to each cartridge (WRITE-ONCE)
		if (run?.cartridgesFilled?.length) {
			const bulkOps = run.cartridgesFilled.map((cf: any) => ({
				updateOne: {
					filter: { _id: cf.cartridgeId, 'reagentFilling.recordedAt': { $exists: false } },
					update: {
						$set: {
							'reagentFilling.runId': run._id,
							'reagentFilling.robotId': run.robot?._id,
							'reagentFilling.robotName': run.robot?.name,
							'reagentFilling.assayType': run.assayType,
							'reagentFilling.deckPosition': cf.deckPosition,
							'reagentFilling.tubeRecords': run.tubeRecords,
							'reagentFilling.operator': run.operator,
							'reagentFilling.fillDate': now,
							'reagentFilling.recordedAt': now,
							currentPhase: 'reagent_filled'
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(bulkOps);
		}

		return { success: true };
	},

	abortRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const reason = data.get('reason') as string;

		await ReagentBatchRecord.findOneAndUpdate(
			{ _id: runId, finalizedAt: { $exists: false } },
			{ $set: { status: 'aborted', abortReason: reason, runEndTime: new Date() } }
		);
		return { success: true };
	},

	addCartridge: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const cartridgeId = data.get('cartridgeId') as string;
		const deckPosition = Number(data.get('deckPosition'));

		await ReagentBatchRecord.findOneAndUpdate(
			{ _id: runId, finalizedAt: { $exists: false } },
			{
				$push: {
					cartridgesFilled: {
						cartridgeId,
						deckPosition,
						inspectionStatus: 'Pending'
					}
				},
				$inc: { cartridgeCount: 1 }
			}
		);
		return { success: true };
	},

	inspectCartridge: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const cartridgeId = data.get('cartridgeId') as string;
		const status = data.get('status') as string;
		const reason = data.get('reason') as string;

		await ReagentBatchRecord.findOneAndUpdate(
			{ _id: runId, 'cartridgesFilled.cartridgeId': cartridgeId },
			{
				$set: {
					'cartridgesFilled.$.inspectionStatus': status,
					'cartridgesFilled.$.inspectionReason': reason || undefined,
					'cartridgesFilled.$.inspectedBy': { _id: locals.user._id, username: locals.user.username },
					'cartridgesFilled.$.inspectedAt': new Date()
				}
			}
		);

		// Write reagentInspection phase to CartridgeRecord (WRITE-ONCE)
		await CartridgeRecord.findOneAndUpdate(
			{ _id: cartridgeId, 'reagentInspection.recordedAt': { $exists: false } },
			{
				$set: {
					'reagentInspection.status': status,
					'reagentInspection.reason': reason || undefined,
					'reagentInspection.operator': { _id: locals.user._id, username: locals.user.username },
					'reagentInspection.timestamp': new Date(),
					'reagentInspection.recordedAt': new Date(),
					currentPhase: status === 'Accepted' ? 'inspected' : 'voided'
				}
			}
		);

		return { success: true };
	},

	applyTopSeal: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const topSealLotId = data.get('topSealLotId') as string;
		const cartridgeCount = Number(data.get('cartridgeCount') || 0);
		const now = new Date();

		const run = await ReagentBatchRecord.findOneAndUpdate(
			{ _id: runId, finalizedAt: { $exists: false } },
			{
				$set: {
					'topSeal.topSealLotId': topSealLotId,
					'topSeal.operator': { _id: locals.user._id, username: locals.user.username },
					'topSeal.firstScanTime': now,
					'topSeal.completionTime': now,
					'topSeal.cartridgeCount': cartridgeCount,
					'topSeal.status': 'completed'
				}
			},
			{ new: true }
		).lean() as any;

		// Write topSeal phase to each accepted cartridge (WRITE-ONCE)
		if (run?.cartridgesFilled?.length) {
			const accepted = run.cartridgesFilled.filter((c: any) => c.inspectionStatus === 'Accepted');
			const bulkOps = accepted.map((cf: any) => ({
				updateOne: {
					filter: { _id: cf.cartridgeId, 'topSeal.recordedAt': { $exists: false } },
					update: {
						$set: {
							'topSeal.batchId': run._id,
							'topSeal.topSealLotId': topSealLotId,
							'topSeal.operator': { _id: locals.user!._id, username: locals.user!.username },
							'topSeal.timestamp': now,
							'topSeal.recordedAt': now,
							currentPhase: 'sealed'
						}
					}
				}
			}));
			if (bulkOps.length) await CartridgeRecord.bulkWrite(bulkOps);
		}

		return { success: true };
	}
};
