import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, ReagentBatchRecord, AssayDefinition, CartridgeRecord, Consumable,
	ManufacturingSettings, WaxFillingRun, Equipment, EquipmentLocation, generateId, AuditLog
} from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import { checkRobotConflict, checkDeckConflict, checkTrayConflict } from '$lib/server/manufacturing/resource-locks';
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
			hasActiveRun: false, stage: null, assayTypeName: null, isResearch: false,
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

		// Load settings and assay types. Hidden assays are excluded from the
		// filling dropdown — they're kept in the catalog (viewable/editable in
		// the settings page) but not offered to operators here.
		const [settingsDoc, assayDefs] = await Promise.all([
			ManufacturingSettings.findById('default').lean(),
			AssayDefinition.find(
				{ isActive: true, hidden: { $ne: true } },
				{ _id: 1, name: 1, skuCode: 1, reagents: 1 }
			).lean()
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

		// This page owns stages Setup → Loading → Running → Inspection.
		// Pre-OT-2 stages have robotReleasedAt unset; Inspection is post-OT-2
		// (completeRunFilling sets robotReleasedAt) but still renders here.
		// The filter is status-based, not robotReleasedAt-based, so an
		// Inspection run keeps loading its cartridges on this page after the
		// OT-2 handoff. Top Sealing / Storage runs live on Opentron Control
		// and must NOT match.
		const PAGE_OWNED_STATUSES = ['Setup', 'Loading', 'Running', 'Inspection', 'setup', 'running'];
		let activeRun: any = null;
		if (robotId) {
			activeRun = await ReagentBatchRecord.findOne({
				'robot._id': robotId,
				status: { $in: PAGE_OWNED_STATUSES }
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
				isResearch: activeRun.isResearch === true,
				cartridgeCount: activeRun.cartridgeCount ?? activeRun.cartridgesFilled?.length ?? 0,
				runStartTime: activeRun.runStartTime ? new Date(activeRun.runStartTime).toISOString() : null,
				runEndTime: activeRun.runEndTime ? new Date(activeRun.runEndTime).toISOString() : null
			}
			: { hasActiveRun: false, stage: null, assayTypeName: null, isResearch: false, cartridgeCount: 0, runStartTime: null, runEndTime: null };

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

		// Fridges for storage selection — use parent Equipment records
		const [equipFridges, orphanFridges] = await Promise.all([
			Equipment.find({ equipmentType: 'fridge', status: { $ne: 'offline' } }).lean().catch(() => []),
			EquipmentLocation.find({ locationType: 'fridge', isActive: true, parentEquipmentId: { $exists: false } }).lean().catch(() => [])
		]);
		const fridges = [
			...(equipFridges as any[]).map((f: any) => ({
				id: String(f._id),
				displayName: f.name ?? f.barcode ?? String(f._id),
				barcode: f.barcode ?? ''
			})),
			...(orphanFridges as any[]).map((f: any) => ({
				id: String(f._id),
				displayName: f.displayName ?? f.barcode ?? String(f._id),
				barcode: f.barcode ?? ''
			}))
		];

		// Check if this robot is blocked by an active wax filling run. Only
		// wax stages owned by the wax-filling page (Setup → Awaiting Removal
		// / PostRunCooling) block — wax runs in QC / Storage live on the
		// Opentron Control post-OT-2 queue and don't block.
		let robotBlocked: { process: 'wax'; runId: string | null } | null = null;
		if (robotId) {
			const waxRun = await WaxFillingRun.findOne({
				'robot._id': robotId,
				status: { $in: ['Setup', 'Loading', 'Running', 'Awaiting Removal',
					'setup', 'loading', 'running', 'awaiting_removal', 'cooling'] }
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

/**
 * Resolve the active run for a post-OT-2 action on this page.
 *
 * Why this exists: once completeRunFilling sets robotReleasedAt, the page's
 * load filter excludes the run from activeRun, so `data.activeRunId` on the
 * client becomes null and submitForm posts `runId=''`. The client page still
 * optimistically shows Inspection/Top Sealing/Storage (pendingStage isn't
 * cleared for those actions), so the operator clicks through and hits these
 * actions with an empty runId — producing a spurious "Run not found".
 *
 * When runId from the form is empty, fall back to the most recent post-OT-2
 * run for this robot. The client sends robotId in every submitForm call.
 */
const POST_OT2_STATUSES = ['Inspection', 'Top Sealing', 'Storage'];
async function resolveRunId(data: FormData): Promise<string | null> {
	const runId = (data.get('runId') as string | null)?.trim() ?? '';
	if (runId) return runId;
	const robotId = (data.get('robotId') as string | null)?.trim() ?? '';
	if (!robotId) return null;
	const run = await ReagentBatchRecord.findOne({
		'robot._id': robotId,
		status: { $in: POST_OT2_STATUSES },
		robotReleasedAt: { $exists: true }
	}).sort({ createdAt: -1 }).select('_id').lean() as any;
	return run ? String(run._id) : null;
}

export const actions: Actions = {
	/** Create a new run */
	createRun: async ({ request, locals, url }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const robotId = (data.get('robotId') as string) ?? url.searchParams.get('robot') ?? '';
		const assayTypeId = (data.get('assayTypeId') as string) || undefined;
		const isResearch = (data.get('isResearch') as string) === 'true';

		// Resolve robot name from layout data (if available)
		const robotName = (data.get('robotName') as string) || robotId;

		// Cross-process robot conflict — blocks if ANY wax OR reagent run on
		// this robot is in a page-owned stage. Partial unique index on the
		// reagent_batch_records collection handles the within-collection race;
		// this catches the cross-collection case (wax already on this robot).
		const robotErr = await checkRobotConflict(robotId);
		if (robotErr) return fail(400, { error: robotErr });

		// Research runs skip assay resolution entirely — assayType stays null
		// and downstream cartridge fields that would be populated from the
		// assay are left blank.
		let assayRef = null;
		if (!isResearch && assayTypeId) {
			const assay = await AssayDefinition.findById(assayTypeId, { _id: 1, name: 1, skuCode: 1 }).lean() as any;
			if (assay) assayRef = { _id: assay._id, name: assay.name, skuCode: assay.skuCode };
		}

		const run = await ReagentBatchRecord.create({
			robot: { _id: robotId, name: robotName },
			assayType: assayRef,
			isResearch,
			operator: { _id: locals.user._id, username: locals.user.username },
			status: 'Loading',
			tubeRecords: [],
			cartridgesFilled: [],
			sealBatches: [],
			setupTimestamp: new Date()
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'reagent_batch_records',
			recordId: String(run._id),
			action: 'INSERT',
			changedBy: locals.user?.username,
			changedAt: new Date()
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
		const hasResearchFlag = data.has('isResearch');
		const isResearch = (data.get('isResearch') as string) === 'true';

		const update: Record<string, any> = { status: 'Loading' };

		// Only touch isResearch if the client sent it — this action is also
		// called for mid-run confirmations where the flag isn't re-submitted.
		if (hasResearchFlag) update.isResearch = isResearch;

		if (isResearch) {
			// Switching to research wipes any prior assay assignment.
			update.assayType = null;
		} else if (assayTypeId) {
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

	/**
	 * Save a batch-level operator note to every cartridge in the run. Overrides
	 * any previous reagent_prep note on each cartridge (pull-then-push) so there
	 * is at most one reagent_prep note per cartridge — idempotent across repeated
	 * saves. Other phases' notes are untouched.
	 */
	recordBatchNote: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const noteBody = ((data.get('noteBody') as string) ?? '').trim();

		if (!runId) return fail(400, { error: 'runId is required' });
		if (!noteBody) return fail(400, { error: 'Note body is empty' });

		const run = await ReagentBatchRecord.findById(runId).select('cartridgesFilled').lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });

		const cartridgeIds: string[] = (run.cartridgesFilled ?? [])
			.map((cf: any) => cf.cartridgeId)
			.filter(Boolean);

		if (cartridgeIds.length === 0) {
			return fail(400, { error: 'No cartridges loaded on this run yet — load the deck first.' });
		}

		const now = new Date();
		const noteId = generateId();

		// Two-step override: Mongo doesn't allow $pull + $push on the same field
		// in one update. Pull first, then push the new entry on every cartridge.
		await CartridgeRecord.updateMany(
			{ _id: { $in: cartridgeIds } },
			{ $pull: { notes: { phase: 'reagent_prep' } } }
		);
		await CartridgeRecord.updateMany(
			{ _id: { $in: cartridgeIds } },
			{
				$push: {
					notes: {
						_id: noteId,
						body: noteBody,
						phase: 'reagent_prep',
						author: { _id: locals.user._id, username: locals.user.username },
						createdAt: now
					}
				}
			}
		);

		return { success: true, noteId, cartridgeCount: cartridgeIds.length };
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

		// Deck conflict check runs at scan time (see /api/dev/validate-equipment
		// ?type=deck). No duplicate check here.

		let cartridgeScans: { cartridgeId: string; deckPosition: number }[] = [];
		if (cartridgeScansRaw) {
			try { cartridgeScans = JSON.parse(cartridgeScansRaw); } catch { /* ignore */ }
		}

		// Check for duplicate barcodes in scan batch
		const scannedIds = cartridgeScans.map((cs: any) => cs.cartridgeId ?? cs.id ?? '');
		const uniqueScanned = new Set(scannedIds);
		if (uniqueScanned.size !== scannedIds.length) {
			const dupes = scannedIds.filter((id: string, i: number) => scannedIds.indexOf(id) !== i);
			return fail(400, { error: `Duplicate barcode(s) scanned: ${[...new Set(dupes)].join(', ')}` });
		}

		// Check if cartridges already have reagent filling
		if (scannedIds.length > 0) {
			const alreadyFilled = await CartridgeRecord.find({
				_id: { $in: scannedIds },
				'reagentFilling.recordedAt': { $exists: true }
			}).select('_id').lean();
			if (alreadyFilled.length > 0) {
				const ids = (alreadyFilled as any[]).map((c: any) => c._id).join(', ');
				return fail(400, { error: `Cartridge(s) already reagent-filled: ${ids}` });
			}

			// Verify cartridges exist in system — they must have come through wax filling
			const existingCartridges = await CartridgeRecord.find({ _id: { $in: scannedIds } })
				.select('_id status')
				.lean();
			const existingIds = new Set((existingCartridges as any[]).map((c: any) => String(c._id)));
			const missingIds = scannedIds.filter((id: string) => !existingIds.has(id));
			if (missingIds.length > 0) {
				return fail(400, { error: `Cartridge ${missingIds[0]} not found. Must complete wax filling first.` });
			}

			// Hard state-machine gate: cartridge MUST be at status='wax_stored'
			// before reagent filling can begin. This prevents the race where a
			// cartridge has been fridge-assigned but the parent wax run isn't
			// yet 'completed' — wax_stored status is set only at wax completeRun,
			// so requiring it here is equivalent to "parent wax run is closed."
			// Applies to both research and production reagent runs.
			const notReady = (existingCartridges as any[]).filter((c: any) => c.status !== 'wax_stored');
			if (notReady.length > 0) {
				const details = notReady.map((c: any) => `${c._id} (status=${c.status ?? 'none'})`).join(', ');
				return fail(400, {
					error: `Cartridge(s) not ready for reagent filling — must be 'wax_stored' first. Complete the wax run (click "Complete Run" on its Storage page) before scanning: ${details}`
				});
			}
		}

		// Validate deck
		if (deckId) {
			const deck = await Equipment.findOne({ _id: deckId, equipmentType: 'deck' }).lean();
			if (!deck && !adminUser) {
				return fail(400, { error: `Deck '${deckId}' not found. Register it in Equipment first.` });
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

		// Upsert CartridgeRecord stubs. In the normal flow these already exist
		// (created at wax deck loading). For anomalous first-time scans at reagent
		// filling we create a minimal record marked 'reagent_filling' so the doc
		// always has a coherent status — never 'backing' (that's reserved for the
		// pre-individuation aggregate count on BackingLot).
		if (cartridgesFilled.length > 0) {
			const ops = cartridgesFilled.map((cf: any) => ({
				updateOne: {
					filter: { _id: cf.cartridgeId },
					update: {
						$setOnInsert: {
							_id: cf.cartridgeId,
							status: 'reagent_filling'
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

		await AuditLog.create({
			_id: generateId(),
			tableName: 'reagent_batch_records',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: runStartTime,
			newData: { status: 'Running', runStartTime }
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
			$set: {
				status: 'Inspection',
				runEndTime: now,
				// Robot is physically free as of now — releases the robot lock so
				// the next wax/reagent run can start while inspection/sealing/
				// storage continue detached on Opentron Control.
				robotReleasedAt: now
			}
		}, { new: true }).lean() as any;

		// Write reagentFilling phase to cartridges (WRITE-ONCE). Research runs
		// leave assayType null on each cartridge — downstream UIs must treat
		// reagentFilling.isResearch === true as "assay intentionally blank".
		if (run?.cartridgesFilled?.length) {
			const isResearch = run.isResearch === true;
			const bulkOps = run.cartridgesFilled.map((cf: any) => ({
				updateOne: {
					filter: { _id: cf.cartridgeId, 'reagentFilling.recordedAt': { $exists: false } },
					update: {
						$set: {
							'reagentFilling.runId': run._id,
							'reagentFilling.robotId': run.robot?._id,
							'reagentFilling.robotName': run.robot?.name,
							'reagentFilling.assayType': isResearch ? null : run.assayType,
							'reagentFilling.isResearch': isResearch,
							'reagentFilling.deckPosition': cf.deckPosition,
							'reagentFilling.tubeRecords': run.tubeRecords,
							'reagentFilling.operator': run.operator,
							'reagentFilling.fillDate': now,
							'reagentFilling.recordedAt': now,
							status: 'reagent_filled'
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(bulkOps);

			// Consume 2ml tubes (PT-CT-107) — FLAT 4 TUBES PER RUN regardless of
			// cartridge count (1–24). Research runs consume the same 4 tubes.
			// TODO: revisit — eventually the tube count should vary per assay
			// (e.g., # of reagents × batch size) rather than a flat 4.
			const tubePartId = await resolvePartId('PT-CT-107');
			await recordTransaction({
				transactionType: 'consumption',
				partDefinitionId: tubePartId ?? undefined,
				quantity: 4,
				manufacturingStep: 'reagent_filling',
				manufacturingRunId: String(run._id),
				operatorId: run.operator?._id,
				operatorUsername: run.operator?.username,
				notes: run.isResearch
					? `Reagent filling run — 4x 2ml tubes (research run, ${run.cartridgesFilled.length} cartridges)`
					: `Reagent filling run — 4x 2ml tubes (assay: ${run.assayType?.name ?? 'unknown'}, ${run.cartridgesFilled.length} cartridges)`
			});
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'reagent_batch_records',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { status: 'Inspection' }
		});

		// Robot is now free. The page's load function will no longer find this run
		// as "active" (robotReleasedAt filters it out), so invalidateAll() will
		// reset the page to "Start new run". The post-OT-2 steps (inspect/seal/
		// store) are accessible from Opentron Control.
		return { success: true };
	},

	/** Complete inspection batch — mark cartridges and move to Top Sealing */
	completeInspectionBatch: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = await resolveRunId(data);
		const rejectedCartridgesRaw = data.get('rejectedCartridges') as string;
		const trayId = ((data.get('trayId') as string | null) ?? '').trim() || undefined;
		const now = new Date();

		let rejectedCartridges: { cartridgeId: string; reason: string; status: string }[] = [];
		if (rejectedCartridgesRaw) {
			try { rejectedCartridges = JSON.parse(rejectedCartridgesRaw); } catch { /* ignore */ }
		}

		if (!runId) return fail(404, { error: 'Run not found' });
		const run = await ReagentBatchRecord.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });

		// Tray conflict runs at scan time (see /api/dev/validate-equipment
		// ?type=tray). No duplicate check here.

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

		const updateFields: Record<string, any> = {
			cartridgesFilled: updatedCartridges,
			status: 'Top Sealing'
		};
		if (trayId) updateFields.trayId = trayId;
		await ReagentBatchRecord.findByIdAndUpdate(runId, { $set: updateFields });

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
						status: 'scrapped',
						voidedAt: now,
						voidReason: `Reagent inspection rejection: ${rej.reason ?? 'unspecified'}`
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
		const runId = await resolveRunId(data);
		if (!runId) return fail(404, { error: 'Run not found' });
		await ReagentBatchRecord.findByIdAndUpdate(runId, { $set: { status: 'Top Sealing' } });
		return { success: true };
	},

	/** Create a top seal batch */
	createTopSealBatch: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = await resolveRunId(data);
		const topSealLotId = data.get('topSealLotId') as string;

		if (!topSealLotId?.trim()) return fail(400, { error: 'Top seal lot ID is required' });
		if (!runId) return fail(404, { error: 'Run not found' });

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
		const runId = await resolveRunId(data);
		const batchId = data.get('batchId') as string;
		const cartridgeRecordId = data.get('cartridgeRecordId') as string;

		if (!cartridgeRecordId) return fail(400, { error: 'Cartridge ID required' });
		if (!runId) return fail(404, { error: 'Run not found' });

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
		const runId = await resolveRunId(data);
		const batchId = data.get('batchId') as string;
		const now = new Date();

		if (!runId) return fail(404, { error: 'Run not found' });

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
							status: 'sealed'
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(bulkOps);

			// Record top seal transactions — consume top seal (PT-CT-103)
			const topSealPartId = await resolvePartId('PT-CT-103');
			for (const cid of batch.cartridgeIds) {
				await recordTransaction({
					transactionType: 'consumption',
					partDefinitionId: topSealPartId ?? undefined,
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

			await AuditLog.create({
				_id: generateId(),
				tableName: 'reagent_batch_records',
				recordId: runId,
				action: 'UPDATE',
				changedBy: locals.user?.username,
				changedAt: now,
				newData: { sealBatchId: batchId, status: 'completed', topSealLotId: batch.topSealLotId }
			});
		}

		return { success: true };
	},

	/** Transition from Top Sealing to Storage */
	/** Reject a cartridge during top sealing */
	rejectAtSeal: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = await resolveRunId(data);
		const cartridgeId = data.get('cartridgeId') as string;
		const now = new Date();

		if (!cartridgeId) return fail(400, { error: 'Cartridge ID required' });
		if (!runId) return fail(404, { error: 'Run not found' });

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
			{ $set: { status: 'scrapped', voidedAt: now, voidReason: 'Rejected at top sealing' } }
		);

		await recordTransaction({
			transactionType: 'scrap',
			cartridgeRecordId: cartridgeId,
			quantity: 1,
			manufacturingStep: 'top_seal',
			manufacturingRunId: runId,
			operatorId: locals.user._id,
			operatorUsername: locals.user.username,
			scrapReason: 'Rejected at top sealing',
			scrapCategory: 'seal_failure',
			notes: 'Top seal rejection'
		});

		return { success: true };
	},

	transitionToStorage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = await resolveRunId(data);
		if (!runId) return fail(404, { error: 'Run not found' });

		await ReagentBatchRecord.findByIdAndUpdate(runId, { $set: { status: 'Storage' } });
		return { success: true };
	},

	/** Record batch storage */
	recordBatchStorage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = await resolveRunId(data);
		const cartridgeIdsRaw = data.get('cartridgeIds') as string;
		const location = data.get('location') as string;
		const now = new Date();

		if (!runId) return fail(404, { error: 'Run not found' });

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
							'storage.fridgeName': location,   // barcode string — for fridgeName-based queries
							'storage.locationId': location,   // same value — for locationId-based queries
							'storage.operator': { _id: locals.user._id, username: locals.user.username },
							'storage.timestamp': now,
							'storage.recordedAt': now,
							status: 'stored'
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

			await AuditLog.create({
				_id: generateId(),
				tableName: 'cartridge_records',
				recordId: cartridgeIds[0] ?? 'batch',
				action: 'UPDATE',
				changedBy: locals.user?.username,
				changedAt: now,
				newData: { status: 'stored', location, count: cartridgeIds.length }
			});
		}

		return { success: true };
	},

	/** Complete the run */
	completeRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = await resolveRunId(data);
		const now = new Date();

		if (!runId) return fail(404, { error: 'Run not found' });

		const run = await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: { status: 'Completed', finalizedAt: now, runEndTime: now }
		}, { new: true }).lean() as any;

		// Update deck usage if deckId is set
		if (run?.deckId) {
			const cartridgeCount = run?.cartridgesFilled?.length ?? 0;
			await Equipment.findByIdAndUpdate(run.deckId, {
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

		await AuditLog.create({
			_id: generateId(),
			tableName: 'reagent_batch_records',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { status: 'Completed' }
		});

		return { success: true };
	},

	/** Cancel a run — only available before the OT-2 finishes */
	cancelRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const reason = (data.get('reason') as string) || 'Cancelled by operator';
		const now = new Date();

		// Once the OT-2 has finished (robotReleasedAt set), the run is committed
		// and can no longer be cancelled. Per-cartridge rejection at inspection
		// or sealing remains available.
		const existing = await ReagentBatchRecord.findById(runId).select('robotReleasedAt').lean() as any;
		if (existing?.robotReleasedAt) {
			return fail(400, { error: 'Cannot cancel: the OT-2 has already completed this run. Reject individual cartridges at inspection or sealing instead.' });
		}

		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: { status: 'Cancelled', abortReason: reason, runEndTime: now }
		});

		// Clean up cartridges that were in reagent_filling phase for this run
		await CartridgeRecord.bulkWrite([{
			updateMany: {
				filter: { 'reagentFilling.runId': runId, status: 'reagent_filling' },
				update: {
					$set: { status: 'wax_filled' },
					$unset: { reagentFilling: '' }
				}
			}
		}]);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'reagent_batch_records',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { status: 'Cancelled', abortReason: reason }
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
		const now = new Date();

		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: {
				status: 'Aborted',
				abortReason: reason,
				abortPhotoUrl: photoUrl,
				runEndTime: now
			}
		});

		// Clean up cartridges that were in reagent_filling phase for this run
		await CartridgeRecord.bulkWrite([{
			updateMany: {
				filter: { 'reagentFilling.runId': runId, status: 'reagent_filling' },
				update: {
					$set: { status: 'wax_filled' },
					$unset: { reagentFilling: '' }
				}
			}
		}]);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'reagent_batch_records',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { status: 'Aborted', abortReason: reason }
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
				{ 'reagentFilling.runId': runId, status: { $nin: ['completed', 'voided'] } },
				{ $set: { status: 'voided', voidedAt: new Date(), voidReason: 'Reset to deck loading' } }
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
