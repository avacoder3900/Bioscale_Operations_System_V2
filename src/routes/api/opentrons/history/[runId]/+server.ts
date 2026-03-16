import { json, error } from '@sveltejs/kit';
import { connectDB, WaxFillingRun, ReagentBatchRecord, CartridgeRecord } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const { runId } = params;
	const processType = url.searchParams.get('type') ?? 'reagent';

	await connectDB();

	if (processType === 'wax') {
		const run = await WaxFillingRun.findById(runId).lean() as any;
		if (!run) throw error(404, 'Run not found');

		// Fetch cartridge details for this wax run
		const cartridgeRecords = run.cartridgeIds?.length
			? await CartridgeRecord.find({ _id: { $in: run.cartridgeIds } },
				{ waxQc: 1, waxStorage: 1, waxFilling: 1 }).lean()
			: [];

		const cartridges = (cartridgeRecords as any[]).map((c) => ({
			cartridgeId: String(c._id),
			deckPosition: c.waxFilling?.deckPosition ?? null,
			qcStatus: c.waxQc?.status ?? 'Pending',
			rejectionReason: c.waxQc?.rejectionReason ?? null,
			storageLocation: c.waxStorage?.location ?? null
		}));

		return json({
			cartridges,
			tubes: [], // Wax runs don't have reagent tubes
			topSealBatches: [],
			abortReason: run.abortReason ?? null,
			abortPhotoUrl: null,
			createdAt: run.createdAt ? new Date(run.createdAt).toISOString() : null,
			startTime: run.runStartTime ? new Date(run.runStartTime).toISOString() : null,
			endTime: run.runEndTime ? new Date(run.runEndTime).toISOString() : null
		});
	} else {
		// Reagent run
		const run = await ReagentBatchRecord.findById(runId).lean() as any;
		if (!run) throw error(404, 'Run not found');

		const cartridges = (run.cartridgesFilled ?? []).map((cf: any) => ({
			cartridgeId: String(cf.cartridgeId),
			deckPosition: cf.deckPosition ?? null,
			qcStatus: cf.inspectionStatus ?? 'Pending',
			rejectionReason: cf.inspectionReason ?? null,
			storageLocation: cf.storageLocation ?? null
		}));

		const tubes = (run.tubeRecords ?? []).map((t: any) => ({
			wellPosition: t.wellPosition ?? 0,
			reagentName: t.reagentName ?? '',
			sourceLotId: t.sourceLotId ?? '',
			transferTubeId: t.transferTubeId ?? ''
		}));

		// Serialize top seal batches (legacy topSeal + new sealBatches)
		const topSealBatches: { batchId: string; topSealLotId: string; operatorId: string; completionTime: string | null }[] = [];

		// From new sealBatches array
		for (const b of run.sealBatches ?? []) {
			topSealBatches.push({
				batchId: String(b._id),
				topSealLotId: b.topSealLotId ?? '',
				operatorId: b.operator?._id ? String(b.operator._id) : '',
				completionTime: b.completionTime ? new Date(b.completionTime).toISOString() : null
			});
		}

		// Legacy topSeal (if exists and not already in sealBatches)
		if (run.topSeal?.topSealLotId && topSealBatches.length === 0) {
			topSealBatches.push({
				batchId: run.topSeal._id ? String(run.topSeal._id) : runId,
				topSealLotId: run.topSeal.topSealLotId,
				operatorId: run.topSeal.operator?._id ? String(run.topSeal.operator._id) : '',
				completionTime: run.topSeal.completionTime ? new Date(run.topSeal.completionTime).toISOString() : null
			});
		}

		return json({
			cartridges,
			tubes,
			topSealBatches,
			abortReason: run.abortReason ?? null,
			abortPhotoUrl: run.abortPhotoUrl ?? null,
			createdAt: run.createdAt ? new Date(run.createdAt).toISOString() : null,
			startTime: run.runStartTime ? new Date(run.runStartTime).toISOString() : null,
			endTime: run.runEndTime ? new Date(run.runEndTime).toISOString() : null
		});
	}
};
