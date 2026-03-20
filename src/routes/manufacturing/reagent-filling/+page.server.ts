import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, ReagentBatchRecord, AssayDefinition, CartridgeRecord, Consumable,
	ManufacturingSettings, WaxFillingRun, EquipmentLocation, generateId, AuditLog
} from '$lib/server/db';
import { recordTransaction } from '$lib/server/services/inventory-transaction';
import type { PageServerLoad, Actions } from './$types';

// Extend Vercel serverless timeout to 60s
export const config = { maxDuration: 60 };

const TERMINAL = new Set(['completed', 'aborted', 'voided', 'cancelled', 'Completed', 'Aborted', 'Cancelled']);

/** Map legacy status → UI stage */
function toStage(status: string | null | undefined): string | null {
	if (!status) return null;
	// Already a UI stage
	if (['Setup', 'Loading', 'Running', 'Inspection', 'Top Sealing', 'Storage'].includes(status)) return status;
	// Legacy mapping
	const map: Record<string, string> = {
		setup: 'Setup', running: 'Running'
	};
	return map[status] ?? null;
}

/** Safe-default empty state for reagent filling on error */
function emptyReagentState(robotId: string, loadError?: string) {
	return {
		robotId,
		activeRunId: null as string | null,
		robotBlocked: null as { process: 'wax'; runId: string | null } | null,
		loadError: loadError ?? null,
		runState: {
			hasActiveRun: false, stage: null, assayTypeName: null,
			cartridgeCount: 0, runStartTime: null, runEndTime: null
		},
		assayTypes: [] as { id: string; name: string; skuCode: string | null; isActive: boolean; reagents: { wellPosition: number; reagentName: string }[] }[],
		reagentDefinitions: [] as { id: string; reagentName: string; wellPosition: number | null; volumeMicroliters: number | null; isActive: boolean }[],
		cartridges: [] as any[],
		currentSealBatch: null as null | { batchId: string; firstScanTime: string | null; cartridgeIds: string[] },
		rejectionCodes: [] as any[],
		tubes: [] as { id: string; reagentName: string; volume: number }[],
		fridges: [] as { id: string; displayName: string; barcode: string }[]
	};
}

export const load: PageServerLoad = async ({ locals, url, parent }) => {
	if (!locals.user) redirect(302, '/login');

	// Get robotId from layout before DB calls
	let layoutData: Awaited<ReturnType<typeof parent>>;
	try {
		layoutData = await parent();
	} catch (err) {
		console.error('[REAGENT-FILLING PAGE] parent() error:', err instanceof Error ? err.message : err);
		return emptyReagentState('', 'Layout data unavailable. Please refresh.');
	}

	const robotIdParam = url.searchParams.get('robot');
	const robotId = String(robotIdParam ?? layoutData.robots?.[0]?.robotId ?? '');

	try {
		await connectDB();

		// Load settings and assay types
		const [settingsDoc, assayDefs] = await Promise.all([
			ManufacturingSettings.findById('default').lean(),
			AssayDefinition.find({ isActive: true }, { _id: 1, name: 1, skuCode: 1, reagents: 1 }).lean()
		]);

		const rejectionCodes = ((settingsDoc as any)?.rejectionReasonCodes ?? [])
			.filter((r: any) => !r.processType || r.processType === 'reagent')
			.map((r: any, i: number) => ({
				id: r._id ? String(r._id) : String(i), code: r.code ?? '', label: r.label ?? ''
			}));

		const assayTypes = (assayDefs as any[]).map((a) => ({
			id: String(a._id), name: a.name ?? '', skuCode: a.skuCode ?? null, isActive: a.isActive ?? true,
			reagents: ((a.reagents ?? []) as any[]).filter((r: any) => r.isActive !== false).map((r: any) => ({
				wellPosition: r.wellPosition ?? 0,
				reagentName: r.reagentName ?? ''
			}))
		}));

		// Get reagent definitions for the active run's assay type (or all if no run)
		let activeRun: any = null;
		if (robotId) {
			activeRun = await ReagentBatchRecord.findOne({
				'robot._id': robotId,
				status: { $nin: [...TERMINAL] }
			}).sort({ createdAt: -1 }).lean().catch(() => null);
		}

		// Reagent definitions from the active run's assay type
		const reagentDefinitions: { id: string; reagentName: string; wellPosition: number | null; volumeMicroliters: number | null; isActive: boolean }[] = [];
		if (activeRun?.assayType?._id) {
			const assay = (assayDefs as any[]).find((a) => String(a._id) === String(activeRun.assayType._id));
			if (assay?.reagents) {
				for (const r of assay.reagents) {
					if (r.isActive !== false) {
						reagentDefinitions.push({
							id: String(r._id),
							reagentName: r.reagentName ?? '',
							wellPosition: r.wellPosition ?? null,
							volumeMicroliters: r.volumeMicroliters ?? null,
							isActive: r.isActive ?? true
						});
					}
				}
			}
		}

		const stage = activeRun ? toStage(activeRun.status) : null;

		const runState = activeRun
			? {
				hasActiveRun: true,
				stage,
				assayTypeName: activeRun.assayType?.name ?? null,
				cartridgeCount: activeRun.cartridgeCount ?? activeRun.cartridgesFilled?.length ?? 0,
				runStartTime: activeRun.runStartTime ? new Date(activeRun.runStartTime).toISOString() : null,
				runEndTime: activeRun.runEndTime ? new Date(activeRun.runEndTime).toISOString() : null
			}
			: { hasActiveRun: false, stage: null, assayTypeName: null, cartridgeCount: 0, runStartTime: null, runEndTime: null };

		// Serialize cartridges
		const cartridges = (activeRun?.cartridgesFilled ?? []).map((cf: any) => ({
			id: cf.cartridgeId ?? '',
			cartridgeId: cf.cartridgeId ?? '',
			deckPosition: cf.deckPosition ?? null,
			inspectionStatus: cf.inspectionStatus ?? 'Pending',
			inspectionReason: cf.inspectionReason ?? null,
			topSealBatchId: cf.topSealBatchId ?? null,
			inspectedBy: cf.inspectedBy?.username ?? null,
			currentStatus: cf.inspectionStatus ?? 'Pending',
			storageLocation: cf.storageLocation ?? null
		}));

		// Current active seal batch (in_progress)
		const currentSealBatch = (() => {
			const batches = activeRun?.sealBatches ?? [];
			const inProgress = batches.find((b: any) => b.status === 'in_progress');
			if (!inProgress) return null;
			const cartridgeIds = (inProgress.cartridgeIds ?? []).map(String);
			return {
				batchId: String(inProgress._id),
				topSealLotId: inProgress.topSealLotId ?? '',
				scannedCount: cartridgeIds.length,
				totalTarget: 12,
				firstScanTime: inProgress.firstScanTime ? new Date(inProgress.firstScanTime).toISOString() : null,
				cartridgeIds
			};
		})();

		// Tube records (reagent prep)
		const tubes = (activeRun?.tubeRecords ?? []).map((t: any) => ({
			id: t._id ? String(t._id) : generateId(),
			reagentName: t.reagentName ?? '',
			volume: t.volumeMicroliters ?? 0
		}));

		// Fridges for storage selection
		const fridgesRaw = await EquipmentLocation.find({ locationType: 'fridge', isActive: true }).lean().catch(() => []);
		const fridges = (fridgesRaw as any[]).map((f: any) => ({
			id: String(f._id),
			displayName: f.displayName ?? f.name ?? String(f._id),
			barcode: f.barcode ?? ''
		}));

		// Check if this robot is blocked by an active wax filling run
		let robotBlocked: { process: 'wax'; runId: string | null } | null = null;
		if (robotId) {
			const waxRun = await WaxFillingRun.findOne({
				'robot._id': robotId,
				status: { $nin: ['completed', 'aborted', 'cancelled', 'voided'] }
			}).lean().catch(() => null) as any;
			if (waxRun) {
				robotBlocked = { process: 'wax', runId: waxRun._id ? String(waxRun._id) : null };
			}
		}

		return {
			robotId,
			activeRunId: activeRun ? String(activeRun._id) : null,
			robotBlocked,
			loadError: null,
			runState,
			assayTypes,
			reagentDefinitions,
			cartridges,
			currentSealBatch,
			rejectionCodes,
			tubes,
			fridges
		};
	} catch (err) {
		console.error('[REAGENT-FILLING PAGE] Load error:', err instanceof Error ? err.message : err);
		// Return safe defaults — do NOT throw; let the page display an error message
		return emptyReagentState(robotId, 'Failed to load reagent filling data. Please refresh the page.');
	}
};

export const actions: Actions = {
	/** Create a new run */
	createRun: async ({ request, locals, url }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const robotId = (data.get('robotId') as string) ?? url.searchParams.get('robot') ?? '';
		const assayTypeId = (data.get('assayTypeId') as string) || undefined;

		// Resolve robot name from layout data (if available)
		const robotName = (data.get('robotName') as string) || robotId;

		// Check for existing active run
		const existing = await ReagentBatchRecord.findOne({
			'robot._id': robotId,
			status: { $nin: [...TERMINAL] }
		}).lean();
		if (existing) return fail(400, { error: 'Robot already has an active run. Complete or cancel it first.' });

		let assayRef = null;
		if (assayTypeId) {
			const assay = await AssayDefinition.findById(assayTypeId, { _id: 1, name: 1, skuCode: 1 }).lean() as any;
			if (assay) assayRef = { _id: assay._id, name: assay.name, skuCode: assay.skuCode };
		}

		await ReagentBatchRecord.create({
			robot: { _id: robotId, name: robotName },
			assayType: assayRef,
			operator: { _id: locals.user._id, username: locals.user.username },
			status: 'Loading',
			tubeRecords: [],
			cartridgesFilled: [],
			sealBatches: [],
			setupTimestamp: new Date()
		});

		return { success: true };
	},

	/** Confirm setup stage */
	confirmSetup: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const assayTypeId = (data.get('assayTypeId') as string) || undefined;

		const update: Record<string, any> = { status: 'Loading' };

		if (assayTypeId) {
			const assay = await AssayDefinition.findById(assayTypeId, { _id: 1, name: 1, skuCode: 1 }).lean() as any;
			if (assay) update.assayType = { _id: assay._id, name: assay.name, skuCode: assay.skuCode };
		}

		await ReagentBatchRecord.findByIdAndUpdate(runId, { $set: update });
		return { success: true };
	},

	/** Record reagent preparation (tubes) */
	recordReagentPrep: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const tubesRaw = data.get('tubes') as string;

		let tubes: { reagentName: string; wellPosition: number; volume: number; lotId?: string; transferTubeId?: string }[] = [];
		if (tubesRaw) {
			try { tubes = JSON.parse(tubesRaw); } catch { /* ignore */ }
		}

		const tubeRecords = tubes.map((t: any) => ({
			wellPosition: t.wellPosition ?? 0,
			reagentName: t.reagentName ?? '',
			sourceLotId: t.lotId ?? t.sourceLotId ?? undefined,
			transferTubeId: t.transferTubeId ?? undefined,
			preparedAt: new Date()
		}));

		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: { tubeRecords, status: 'Loading' }
		});

		return { success: true };
	},

	/** Load deck with cartridges */
	loadDeck: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const deckId = (data.get('deckId') as string) || undefined;
		const cartridgeScansRaw = data.get('cartridgeScans') as string;
		const adminUser = (data.get('adminUser') as string) || undefined;

		let cartridgeScans: { cartridgeId: string; deckPosition: number }[] = [];
		if (cartridgeScansRaw) {
			try { cartridgeScans = JSON.parse(cartridgeScansRaw); } catch { /* ignore */ }
		}

		// Validate deck
		if (deckId) {
			const deck = await Consumable.findOne({ _id: deckId, type: 'deck' }).lean();
			if (!deck && !adminUser) {
				return fail(400, { error: `Deck '${deckId}' not found. Register it in Consumables first.` });
			}
			if ((deck as any)?.status === 'retired' && !adminUser) {
				return fail(400, { error: `Deck '${deckId}' is retired.` });
			}
		}

		const cartridgesFilled = cartridgeScans.map((cs: any) => ({
			cartridgeId: cs.cartridgeId ?? cs.id ?? '',
			deckPosition: cs.deckPosition ?? cs.position ?? 0,
			inspectionStatus: 'Pending'
		}));

		// Create CartridgeRecord stubs
		if (cartridgesFilled.length > 0) {
			const ops = cartridgesFilled.map((cf: any) => ({
				updateOne: {
					filter: { _id: cf.cartridgeId },
					update: {
						$setOnInsert: {
							_id: cf.cartridgeId,
							currentPhase: 'backing',
							'backing.operator': { _id: locals.user._id, username: locals.user.username },
							'backing.recordedAt': new Date()
						}
					},
					upsert: true
				}
			}));
			await CartridgeRecord.bulkWrite(ops);
		}

		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: {
				cartridgesFilled,
				cartridgeCount: cartridgesFilled.length,
				deckId: deckId ?? undefined,
				status: 'Loading'
			}
		});

		return { success: true };
	},

	/** Start the run */
	startRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;

		const run = await ReagentBatchRecord.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });

		// Compute run end time based on settings
		const settingsDoc = await ManufacturingSettings.findById('default').lean() as any;
		const fillTime = settingsDoc?.reagentFilling?.fillTimePerCartridgeMin ?? 0.5;
		const cartridgeCount = run.cartridgeCount ?? run.cartridgesFilled?.length ?? 0;
		const runDurationMs = cartridgeCount * fillTime * 60 * 1000;
		const runStartTime = new Date();
		const runEndTime = new Date(runStartTime.getTime() + runDurationMs);

		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: { status: 'Running', runStartTime, runEndTime }
		});

		return { success: true };
	},

	/** Complete run filling — move to Inspection */
	completeRunFilling: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const now = new Date();

		const run = await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: { status: 'Inspection', runEndTime: now }
		}, { new: true }).lean() as any;

		// Write reagentFilling phase to cartridges (WRITE-ONCE)
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

			// Record inventory transactions for reagent filling
			for (const cf of run.cartridgesFilled) {
				await recordTransaction({
					transactionType: 'creation',
					cartridgeRecordId: cf.cartridgeId,
					quantity: 1,
					manufacturingStep: 'reagent_filling',
					manufacturingRunId: String(run._id),
					operatorId: run.operator?._id,
					operatorUsername: run.operator?.username,
					notes: `Reagent-filled cartridge (assay: ${run.assayType?.name ?? 'unknown'})`
				});
			}
		}

		return { success: true };
	},

	/** Complete inspection batch — mark cartridges and move to Top Sealing */
	completeInspectionBatch: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const rejectedCartridgesRaw = data.get('rejectedCartridges') as string;
		const now = new Date();

		let rejectedCartridges: { cartridgeId: string; reason: string; status: string }[] = [];
		if (rejectedCartridgesRaw) {
			try { rejectedCartridges = JSON.parse(rejectedCartridgesRaw); } catch { /* ignore */ }
		}

		const run = await ReagentBatchRecord.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });

		// Build update for each cartridge's inspection status
		const rejectedMap = new Map(rejectedCartridges.map((c: any) => [c.cartridgeId, c]));
		const updatedCartridges = (run.cartridgesFilled ?? []).map((cf: any) => {
			const rejected = rejectedMap.get(cf.cartridgeId);
			if (rejected) {
				return {
					...cf,
					inspectionStatus: rejected.status ?? 'Rejected',
					inspectionReason: rejected.reason ?? null,
					inspectedBy: { _id: locals.user._id, username: locals.user.username },
					inspectedAt: now
				};
			}
			return { ...cf, inspectionStatus: cf.inspectionStatus === 'Pending' ? 'Accepted' : cf.inspectionStatus, inspectedBy: { _id: locals.user._id, username: locals.user.username }, inspectedAt: now };
		});

		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: { cartridgesFilled: updatedCartridges, status: 'Top Sealing' }
		});

		// Write reagentInspection to CartridgeRecord (WRITE-ONCE for rejected)
		for (const rej of rejectedCartridges) {
			await CartridgeRecord.findOneAndUpdate(
				{ _id: rej.cartridgeId, 'reagentInspection.recordedAt': { $exists: false } },
				{
					$set: {
						'reagentInspection.status': rej.status ?? 'Rejected',
						'reagentInspection.reason': rej.reason ?? undefined,
						'reagentInspection.operator': { _id: locals.user._id, username: locals.user.username },
						'reagentInspection.timestamp': now,
						'reagentInspection.recordedAt': now,
						currentPhase: 'voided'
					}
				}
			);

			// Record scrap transaction for rejected cartridge
			await recordTransaction({
				transactionType: 'scrap',
				cartridgeRecordId: rej.cartridgeId,
				quantity: 1,
				manufacturingStep: 'reagent_filling',
				manufacturingRunId: runId,
				operatorId: locals.user._id,
				operatorUsername: locals.user.username,
				scrapReason: rej.reason ?? 'Reagent inspection rejection',
				scrapCategory: 'reagent_defect',
				notes: `Reagent inspection rejection: ${rej.reason ?? 'No reason provided'}`
			});
		}

		return { success: true };
	},

	/** Alias for completeInspectionBatch */
	completeInspection: async ({ request, locals }) => {
		// Delegate to completeInspectionBatch
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		await ReagentBatchRecord.findByIdAndUpdate(runId, { $set: { status: 'Top Sealing' } });
		return { success: true };
	},

	/** Create a top seal batch */
	createTopSealBatch: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const topSealLotId = data.get('topSealLotId') as string;

		if (!topSealLotId?.trim()) return fail(400, { error: 'Top seal lot ID is required' });

		const batchId = generateId();
		const now = new Date();

		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$push: {
				sealBatches: {
					_id: batchId,
					topSealLotId: topSealLotId.trim(),
					operator: { _id: locals.user._id, username: locals.user.username },
					firstScanTime: now,
					cartridgeIds: [],
					status: 'in_progress'
				}
			}
		});

		return { success: true, batchId };
	},

	/** Scan a cartridge into a seal batch */
	scanCartridgeForSeal: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const batchId = data.get('batchId') as string;
		const cartridgeRecordId = data.get('cartridgeRecordId') as string;

		if (!cartridgeRecordId) return fail(400, { error: 'Cartridge ID required' });

		// Mark cartridge in the sealBatch as scanned
		await ReagentBatchRecord.findOneAndUpdate(
			{ _id: runId, 'sealBatches._id': batchId },
			{ $addToSet: { 'sealBatches.$.cartridgeIds': cartridgeRecordId } }
		);

		// Mark the cartridgeFilled entry with topSealBatchId
		await ReagentBatchRecord.findOneAndUpdate(
			{ _id: runId, 'cartridgesFilled.cartridgeId': cartridgeRecordId },
			{ $set: { 'cartridgesFilled.$.topSealBatchId': batchId } }
		);

		return { success: true };
	},

	/** Complete a seal batch */
	completeSealBatch: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const batchId = data.get('batchId') as string;
		const now = new Date();

		const run = await ReagentBatchRecord.findOneAndUpdate(
			{ _id: runId, 'sealBatches._id': batchId },
			{
				$set: {
					'sealBatches.$.status': 'completed',
					'sealBatches.$.completionTime': now
				}
			},
			{ new: true }
		).lean() as any;

		// Write topSeal phase to each cartridge in the batch (WRITE-ONCE)
		const batch = (run?.sealBatches ?? []).find((b: any) => String(b._id) === batchId);
		if (batch?.cartridgeIds?.length) {
			const bulkOps = batch.cartridgeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'topSeal.recordedAt': { $exists: false } },
					update: {
						$set: {
							'topSeal.batchId': batchId,
							'topSeal.topSealLotId': batch.topSealLotId,
							'topSeal.operator': { _id: locals.user._id, username: locals.user.username },
							'topSeal.timestamp': now,
							'topSeal.recordedAt': now,
							currentPhase: 'sealed'
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(bulkOps);

			// Record top seal transactions
			for (const cid of batch.cartridgeIds) {
				await recordTransaction({
					transactionType: 'creation',
					cartridgeRecordId: cid,
					quantity: 1,
					manufacturingStep: 'top_seal',
					manufacturingRunId: runId,
					operatorId: locals.user._id,
					operatorUsername: locals.user.username,
					lotId: batch.topSealLotId ?? undefined,
					notes: `Top seal applied (batch ${batchId})`
				});
			}
		}

		return { success: true };
	},

	/** Transition from Top Sealing to Storage */
	/** Reject a cartridge during top sealing */
	rejectAtSeal: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const cartridgeId = data.get('cartridgeId') as string;
		const now = new Date();

		if (!cartridgeId) return fail(400, { error: 'Cartridge ID required' });

		// Update inspection status to Rejected in the run's cartridgesFilled
		await ReagentBatchRecord.findOneAndUpdate(
			{ _id: runId, 'cartridgesFilled.cartridgeId': cartridgeId },
			{
				$set: {
					'cartridgesFilled.$.inspectionStatus': 'Rejected',
					'cartridgesFilled.$.inspectionReason': 'Rejected at top sealing',
					'cartridgesFilled.$.inspectedBy': { _id: locals.user._id, username: locals.user.username },
					'cartridgesFilled.$.inspectedAt': now
				}
			}
		);

		// Update CartridgeRecord
		await CartridgeRecord.findOneAndUpdate(
			{ _id: cartridgeId },
			{ $set: { currentPhase: 'voided', voidedAt: now, voidReason: 'Rejected at top sealing' } }
		);

		return { success: true };
	},

	transitionToStorage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;

		await ReagentBatchRecord.findByIdAndUpdate(runId, { $set: { status: 'Storage' } });
		return { success: true };
	},

	/** Record batch storage */
	recordBatchStorage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const cartridgeIdsRaw = data.get('cartridgeIds') as string;
		const location = data.get('location') as string;
		const now = new Date();

		let cartridgeIds: string[] = [];
		try { cartridgeIds = JSON.parse(cartridgeIdsRaw); } catch { /* ignore */ }

		if (cartridgeIds.length > 0) {
			// Update storage location in cartridgesFilled
			for (const cid of cartridgeIds) {
				await ReagentBatchRecord.findOneAndUpdate(
					{ _id: runId, 'cartridgesFilled.cartridgeId': cid },
					{
						$set: {
							'cartridgesFilled.$.storageLocation': location,
							'cartridgesFilled.$.storedAt': now
						}
					}
				);
			}

			// Write storage phase to CartridgeRecord
			const bulkOps = cartridgeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'storage.recordedAt': { $exists: false } },
					update: {
						$set: {
							'storage.fridgeName': location,
							'storage.operator': { _id: locals.user._id, username: locals.user.username },
							'storage.timestamp': now,
							'storage.recordedAt': now,
							currentPhase: 'stored'
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(bulkOps);

			// Record storage transactions
			for (const cid of cartridgeIds) {
				await recordTransaction({
					transactionType: 'creation',
					cartridgeRecordId: cid,
					quantity: 1,
					manufacturingStep: 'storage',
					manufacturingRunId: runId,
					operatorId: locals.user._id,
					operatorUsername: locals.user.username,
					notes: `Stored in ${location}`
				});
			}
		}

		return { success: true };
	},

	/** Complete the run */
	completeRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const now = new Date();

		const run = await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: { status: 'Completed', finalizedAt: now, runEndTime: now }
		}, { new: true }).lean() as any;

		// Update deck usage if deckId is set
		if (run?.deckId) {
			const cartridgeCount = run?.cartridgesFilled?.length ?? 0;
			await Consumable.findByIdAndUpdate(run.deckId, {
				$set: { lastUsed: now },
				$push: {
					usageLog: {
						_id: generateId(),
						usageType: 'run_complete', runId: run._id,
						quantityChanged: cartridgeCount,
						operator: { _id: locals.user._id, username: locals.user.username },
						notes: `Reagent filling run complete — ${cartridgeCount} cartridges filled`,
						createdAt: now
					}
				}
			});
		}

		return { success: true };
	},

	/** Cancel a run */
	cancelRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const reason = (data.get('reason') as string) || 'Cancelled by operator';

		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: { status: 'Cancelled', abortReason: reason, runEndTime: new Date() }
		});
		return { success: true };
	},

	/** Abort a run */
	abortRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const reason = (data.get('reason') as string) || 'Aborted';
		const photoUrl = (data.get('photoUrl') as string) || undefined;

		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: {
				status: 'Aborted',
				abortReason: reason,
				abortPhotoUrl: photoUrl,
				runEndTime: new Date()
			}
		});
		return { success: true };
	},

	/** Reset to deck loading — clear cartridges and seal batches, go back to Loading */
	resetToLoading: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;

		const run = await ReagentBatchRecord.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });

		// Void all CartridgeRecord entries for this run
		if (run.cartridgesFilled?.length) {
			await CartridgeRecord.updateMany(
				{ 'reagentFilling.runId': runId, currentPhase: { $nin: ['completed', 'voided'] } },
				{ $set: { currentPhase: 'voided', voidedAt: new Date(), voidReason: 'Reset to deck loading' } }
			);
		}

		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: {
				cartridgesFilled: [],
				cartridgeCount: 0,
				sealBatches: [],
				deckId: undefined,
				status: 'Loading'
			},
			$unset: { runStartTime: '', runEndTime: '' }
		});

		return { success: true };
	},

	/** Force advance to a specific stage (admin skip) */
	forceAdvanceStage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const targetStage = data.get('targetStage') as string;

		const validStages = ['Setup', 'Loading', 'Running', 'Inspection', 'Top Sealing', 'Storage'];
		if (!validStages.includes(targetStage)) {
			return fail(400, { error: `Invalid target stage: ${targetStage}` });
		}

		// Get current status before advancing
		const run = await ReagentBatchRecord.findById(runId, { status: 1 }).lean() as any;
		const previousStage = run?.status ?? null;

		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: { status: targetStage }
		});

		// ISO 13485 audit trail for force advance
		await AuditLog.create({
			_id: generateId(),
			tableName: 'reagent_batch_records',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: new Date(),
			oldData: { status: previousStage },
			newData: { status: targetStage },
			reason: `Admin force-advance from "${previousStage}" to "${targetStage}"`
		});

		return { success: true };
	}
};
