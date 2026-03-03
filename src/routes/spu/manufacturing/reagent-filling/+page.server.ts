import { redirect } from '@sveltejs/kit';
import { connectDB, ReagentBatchRecord, AssayDefinition, CartridgeRecord } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const [runs, assayTypes] = await Promise.all([
		ReagentBatchRecord.find().sort({ createdAt: -1 }).limit(50).lean(),
		AssayDefinition.find({ isActive: true }, { _id: 1, name: 1, skuCode: 1 }).lean()
	]);

	// Find the most recent active run
	const activeRun = runs.find((r: any) => !['completed', 'cancelled', 'aborted'].includes(r.status));

	const runState: {
		hasActiveRun: boolean;
		stage: string | null;
		assayTypeName: string | null;
		cartridgeCount: number;
		runStartTime: number | null;
		runEndTime: number | null;
	} = activeRun
		? {
				hasActiveRun: true,
				stage: activeRun.status ?? 'Running',
				assayTypeName: (activeRun as any).assayType?.name ?? null,
				cartridgeCount: (activeRun as any).cartridgeCount ?? 0,
				runStartTime: (activeRun as any).runStartTime
					? new Date((activeRun as any).runStartTime).getTime()
					: null,
				runEndTime: (activeRun as any).runEndTime
					? new Date((activeRun as any).runEndTime).getTime()
					: null
			}
		: { hasActiveRun: false, stage: null, assayTypeName: null, cartridgeCount: 0, runStartTime: null, runEndTime: null };

	// Get cartridges for the active run
	const cartridges: Array<{
		cartridgeId: string;
		barcode: string;
		inspectionStatus: string | null;
		inspectionReason: string | null;
		topSealBatchId: string | null;
		inspectedBy: string | null;
	}> = activeRun
		? ((activeRun as any).cartridgesFilled ?? []).map((cf: any) => ({
				cartridgeId: cf.cartridgeId ?? '',
				barcode: cf.barcode ?? '',
				inspectionStatus: cf.inspectionStatus ?? null,
				inspectionReason: cf.inspectionReason ?? null,
				topSealBatchId: cf.topSealBatchId ?? null,
				inspectedBy: cf.inspectedBy?.username ?? null
			}))
		: [];

	return {
		runs: runs.map((r: any) => ({
			id: r._id,
			runId: r._id,
			runNumber: r.runNumber ?? r._id,
			robotId: r.robot?._id ?? null,
			robotName: r.robot?.name ?? null,
			status: r.status ?? null,
			stage: r.status ?? null,
			assayTypeId: r.assayType?._id ?? null,
			assayTypeName: r.assayType?.name ?? null,
			cartridgeCount: r.cartridgeCount ?? r.cartridgesFilled?.length ?? 0,
			qaqcCount: (r.cartridgesFilled ?? []).filter((cf: any) => cf.inspectionStatus === 'Accepted').length,
			qaqcCartridgeIds: (r.cartridgesFilled ?? [])
				.filter((cf: any) => cf.inspectionStatus === 'Accepted')
				.map((cf: any) => cf.cartridgeId),
			startTime: r.runStartTime ?? null,
			endTime: r.runEndTime ?? null,
			createdAt: r.createdAt
		})),
		assayTypes: assayTypes.map((a: any) => ({
			id: a._id, name: a.name, skuCode: a.skuCode ?? null
		})),
		runState,
		activeRunId: activeRun ? (activeRun as any)._id : null,
		robotId: activeRun ? (activeRun as any).robot?._id ?? '' : '',
		robotBlocked: null as { runId: string | null } | null,
		reagentDefinitions: [] as Array<{
			id: string;
			reagentName: string;
			wellPosition: number | null;
			volumeMicroliters: number | null;
		}>,
		cartridges,
		currentSealBatch: null as {
			batchId: string;
			firstScanTime: string | null;
			cartridgeIds: string[];
		} | null,
		rejectionCodes: [] as Array<{ id: string; code: string; label: string }>,
		tubes: [] as Array<{ id: string; reagentName: string; volume: number }>
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
