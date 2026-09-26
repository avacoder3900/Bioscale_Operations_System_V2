import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, ReagentBatchRecord, AssayDefinition, CartridgeRecord, Consumable,
	ManufacturingSettings, WaxFillingRun, Equipment, EquipmentLocation, generateId, AuditLog,
	ReagentLot,
	OpentronsRobot, Ot2BridgeCommand
} from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import { findBucketLabels } from '$lib/server/services/bucket-service';
import { checkRobotConflict, checkDeckConflict, checkTrayConflict } from '$lib/server/manufacturing/resource-locks';
import { WAX_PAGE_OWNED } from '$lib/server/manufacturing/run-statuses';
import { getRobot, robotGet, bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';
import { requirePermission } from '$lib/server/permissions';
// OT2-TAILNET-5 §7.1: the run lifecycle's BIMS halves (moved out of this file,
// unchanged) + the prepare/confirm actions the tailnet line calls.
import {
	finalizeReagentRun,
	startRunQueue,
	recordRunFinishedQueue,
	stopRunQueue,
	reconcileStartIntent,
	setRunRecordStatus,
	lifecycleActions,
	isActionFail
} from '$lib/server/opentrons/run-lifecycle-records';
import { isReagentEligible } from '$lib/shared/cartridge-wax-status';
import type { PageServerLoad, Actions } from './$types';

// Extend Vercel serverless timeout to 60s
export const config = { maxDuration: 60 };

const TERMINAL = new Set(['completed', 'aborted', 'voided', 'cancelled', 'Completed', 'Aborted', 'Cancelled']);

/** Map legacy status → UI stage */
function toStage(status: string | null | undefined): string | null {
	if (!status) return null;
	// Already a UI stage
	if (['Setup', 'Loading', 'Running'].includes(status)) return status;
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
			assayTypeId: null as string | null, isResearch: false,
			cartridgeCount: 0, runStartTime: null, runEndTime: null,
			opentronsRunId: null as string | null,
			opentronsRunFinalStatus: null as string | null,
			protocolParameters: null as Record<string, unknown> | null,
			startInterrupted: null as string | null
		},
		activeReagentLots: {} as Record<string, any[]>,
		assayTypes: [] as { id: string; name: string; skuCode: string | null; isActive: boolean; reagents: { wellPosition: number; reagentName: string }[] }[],
		reagentDefinitions: [] as { id: string; reagentName: string; wellPosition: number | null; volumeMicroliters: number | null; isActive: boolean }[],
		cartridges: [] as any[],
		rejectionCodes: [] as any[],
		tubes: [] as { id: string; reagentName: string; volume: number }[],
		reagentPrepDone: false,
		reagentBatchBarcode: null as string | null,
		fridges: [] as { id: string; displayName: string; barcode: string }[],
		robotProtocols: [] as Array<{
			opentronsProtocolId: string;
			protocolName: string;
			protocolType: string | null;
			analysisStatus: string | null;
			parametersSchema: any;
		}>,
		opentronsRobotId: robotId,
		lastTipState: null as null | {
			nextTipIndex: number | null;
			hostname: string | null;
			capturedAt: string | null;
		}
	};
}

export const load: PageServerLoad = async ({ locals, url, parent }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'reagentFilling:read');

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

		// This page owns stages Setup → Loading → Running. Running is terminal:
		// completeRunFilling marks the run Completed (REAGENT-TOPSEAL-IMPLICIT),
		// so a completed run must NOT match here. Legacy 'Inspection' /
		// 'Top Sealing' / 'Storage' runs (pre-migration) are not page-owned either.
		const PAGE_OWNED_STATUSES = ['Setup', 'Loading', 'Running', 'setup', 'running'];
		let activeRun: any = null;
		if (robotId) {
			activeRun = await ReagentBatchRecord.findOne({
				'robot._id': robotId,
				status: { $in: PAGE_OWNED_STATUSES }
			}).sort({ createdAt: -1 }).lean().catch(() => null);
		}

		// Two-phase start (OT2-TAILNET-5): a start whose page died between "robot
		// started" and "confirm" left startIntent set. Find the robot's run and
		// confirm it, or clear the intent once nothing can still be in flight.
		let startInterrupted: string | null = null;
		if (activeRun?.startIntent?.token) {
			const rec = await reconcileStartIntent('reagent', activeRun, { _id: locals.user._id, username: locals.user.username });
			startInterrupted = rec.banner;
			if (rec.changed) activeRun = await ReagentBatchRecord.findById(activeRun._id).lean().catch(() => activeRun);
		}

		// SELF-HEAL (2026-08-28, parity with wax): finalize a finished run on
		// the next visit if no browser tab was alive to do it — the robot must
		// not stay locked (and the carts unstamped) because a tab closed at the
		// wrong moment. Handles both a stamped-but-never-completed run and one
		// where even the final status was never recorded (polls the robot).
		if (activeRun && ['Running', 'running'].includes(activeRun.status)) {
			try {
				let final = String(activeRun.opentronsRunFinalStatus ?? '').toLowerCase();
				if (!final && activeRun.opentronsRunId) {
					const rRobot = await getRobot(activeRun.robot?._id);
					if (rRobot) {
						const rs = await robotGet(rRobot, `/runs/${activeRun.opentronsRunId}`);
						if (rs.ok) final = String(((await rs.json())?.data?.status ?? '')).toLowerCase();
					}
					if (final === 'succeeded') {
						await ReagentBatchRecord.findByIdAndUpdate(activeRun._id, {
							$set: { opentronsRunFinalStatus: final }
						});
					}
				}
				if (final === 'succeeded') {
					await finalizeReagentRun(
						String(activeRun._id),
						{ _id: locals.user._id, username: locals.user.username },
						'auto (load reconcile)'
					);
					await setRunRecordStatus(String(activeRun._id), activeRun.opentronsRunId, 'succeeded');
					activeRun = null; // page renders idle — run is done
				}
			} catch (e) {
				console.error('[reagent load] run reconcile failed:', e instanceof Error ? e.message : e);
			}
		}

		// Robot's uploaded protocols (parameter schemas) + the most recent
		// completed reagent run's tip-tracker snapshot — both feed the
		// Start Run panel (protocol picker + "tips remaining" readout).
		const [robotDoc, lastTipRun] = await Promise.all([
			robotId ? OpentronsRobot.findById(robotId).lean().catch(() => null) : Promise.resolve(null),
			robotId
				? ReagentBatchRecord.findOne({
					'robot._id': robotId,
					'pipetteTipState.after.nextTipIndex': { $exists: true }
				}).sort({ runEndTime: -1 }).select('pipetteTipState').lean().catch(() => null)
				: Promise.resolve(null)
		]);
		const robotProtocols = ((robotDoc as any)?.protocols ?? []).map((p: any) => ({
			opentronsProtocolId: p.opentronsProtocolId ?? null,
			protocolName: p.protocolName ?? '',
			protocolType: p.protocolType ?? null,
			analysisStatus: p.analysisStatus ?? null,
			parametersSchema: p.parametersSchema ?? null
		// Only offer reagent-filling protocols on the reagent stage — a
		// wax-filling protocol must never be startable here. Empty -> panel
		// shows its no-protocol state.
		})).filter((p: any) => p.opentronsProtocolId && p.protocolType === 'reagent-filling');
		const lastTipState = (lastTipRun as any)?.pipetteTipState?.after
			? {
				nextTipIndex: (lastTipRun as any).pipetteTipState.after.nextTipIndex ?? null,
				hostname: (lastTipRun as any).pipetteTipState.after.hostname ?? null,
				capturedAt: (lastTipRun as any).pipetteTipState.after.capturedAt
					? new Date((lastTipRun as any).pipetteTipState.after.capturedAt).toISOString()
					: null
			}
			: null;

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
				// Assay _id so "Run again" can recreate a run with the same assay.
				assayTypeId: activeRun.assayType?._id ?? null,
				isResearch: activeRun.isResearch === true,
				cartridgeCount: activeRun.cartridgeCount ?? activeRun.cartridgesFilled?.length ?? 0,
				runStartTime: activeRun.runStartTime ? new Date(activeRun.runStartTime).toISOString() : null,
				runEndTime: activeRun.runEndTime ? new Date(activeRun.runEndTime).toISOString() : null,
				opentronsRunId: activeRun.opentronsRunId ?? null,
				// Terminal .py status (stamped by recordRunFinished) — gates the
				// run-complete UI (Complete + Run again) on the Running stage, on reload too.
				opentronsRunFinalStatus: activeRun.opentronsRunFinalStatus ?? null,
				protocolParameters: activeRun.protocolParameters ?? null,
				// "start interrupted — check robot" (a start intent older than 10 min).
				startInterrupted
			}
			: { hasActiveRun: false, stage: null, assayTypeName: null, assayTypeId: null, isResearch: false, cartridgeCount: 0, runStartTime: null, runEndTime: null, opentronsRunId: null, opentronsRunFinalStatus: null, protocolParameters: null, startInterrupted: null };

		// Serialize cartridges
		const cartridges = (activeRun?.cartridgesFilled ?? []).map((cf: any) => ({
			id: cf.cartridgeId ?? '',
			cartridgeId: cf.cartridgeId ?? '',
			deckPosition: cf.deckPosition ?? null,
			inspectionStatus: cf.inspectionStatus ?? 'Pending',
			inspectionReason: cf.inspectionReason ?? null,
			inspectedBy: cf.inspectedBy?.username ?? null,
			currentStatus: cf.inspectionStatus ?? 'Pending',
			storageLocation: cf.storageLocation ?? null
		}));

		// Tube records (reagent prep)
		const tubes = (activeRun?.tubeRecords ?? []).map((t: any) => ({
			id: t._id ? String(t._id) : generateId(),
			reagentName: t.reagentName ?? '',
			volume: t.volumeMicroliters ?? 0
		}));

		// Finalized ReagentLots eligible to feed cartridge fills, grouped by
		// protocol slug. UI dropdown wire-up is pending (see TODO below) —
		// the data is here so the picker can land without a second backend pass.
		// TODO(reagent-qc): wire `activeReagentLots[slug]` into a dropdown on the
		// ReagentPreparation tube rows so the operator picks a finalized lot per
		// reagent type instead of typing a freeform lotId. Then on
		// completeRunFilling, decrement `remainingVolume` on each chosen lot by
		// (cartridgesFilled * wellVolume) — currently left untouched per user
		// direction 2026-05-14.
		const finalizedLots = await ReagentLot.find({ status: 'finalized' })
			.select('_id lotBarcode templateSlug templateName templateVersion finalOutputs operator finalizedAt')
			.sort({ finalizedAt: -1 })
			.limit(200)
			.lean()
			.catch(() => []);
		const activeReagentLots: Record<string, any[]> = {};
		for (const l of finalizedLots as any[]) {
			const slug = l.templateSlug ?? 'unknown';
			if (!activeReagentLots[slug]) activeReagentLots[slug] = [];
			activeReagentLots[slug].push({
				_id: String(l._id),
				lotBarcode: l.lotBarcode,
				templateName: l.templateName,
				templateVersion: l.templateVersion,
				concentration: l.finalOutputs?.concentration ?? null,
				concentrationUnit: l.finalOutputs?.concentrationUnit ?? null,
				operator: l.operator?.username ?? null,
				finalizedAt: l.finalizedAt ?? null
			});
		}

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
				status: { $in: WAX_PAGE_OWNED }
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
			rejectionCodes,
			tubes,
			// Reagent-batch prep state, server-derived so it survives a reload (the
			// batch is now selected BEFORE the deck scan, which reloads the page).
			reagentPrepDone: (activeRun?.tubeRecords ?? []).length > 0,
			reagentBatchBarcode: (activeRun?.tubeRecords ?? [])[0]?.sourceLotId ?? null,
			fridges,
			activeReagentLots,
			// --- OT-2 Start Run panel inputs (same shape as wax-filling) ---
			robotProtocols,
			opentronsRobotId: robotId,
			lastTipState
		};
	} catch (err) {
		console.error('[REAGENT-FILLING PAGE] Load error:', err instanceof Error ? err.message : err);
		// Return safe defaults — do NOT throw; let the page display an error message
		return emptyReagentState(robotId, 'Failed to load reagent filling data. Please refresh the page.');
	}
};

// stopRobotRun, PRE_REAGENT_STATUSES and finalizeReagentRun moved to
// $lib/server/opentrons/run-lifecycle-records (the stop is the shared 'run.stop' verb).

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
			operator: { _id: locals.user!._id, username: locals.user!.username },
			status: 'Loading',
			tubeRecords: [],
			cartridgesFilled: [],
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
	/**
	 * Persist the operator's planned cartridge count the moment the params step is
	 * confirmed (BEFORE any scan). The auto barcode sweep previously relied on the
	 * browser tab still holding the params FormData — a reload, a second tab, or a
	 * fast Run-again lost it and the sweep walked all 24 positions (seen 08-24 and
	 * again 08-27 on R04 with 20 selected). The sweep endpoint now reads this
	 * server-side value and clamps its default instead of trusting tab state.
	 */
	savePlannedCount: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const data = await request.formData();
		const runId = data.get('runId')?.toString();
		const n = Math.floor(Number(data.get('plannedCartridgeCount')));
		if (!runId) return fail(400, { error: 'Missing runId' });
		if (!Number.isFinite(n) || n < 1 || n > 24) return fail(400, { error: 'plannedCartridgeCount must be 1-24' });
		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: { plannedCartridgeCount: n, plannedCountAt: new Date() }
		});
		return { success: true, plannedCartridgeCount: n };
	},

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

		const noteEntry = {
			_id: noteId,
			body: noteBody,
			phase: 'reagent_prep',
			author: { _id: locals.user!._id, username: locals.user!.username },
			createdAt: now
		};

		// Two-step override: Mongo doesn't allow $pull + $push on the same field
		// in one update. Pull first, then push the new entry on every cartridge
		// AND on the run document — a single reagent_prep note exists in both
		// places, so run-history surfaces can read run.notes directly without
		// touching cartridges.
		await Promise.all([
			CartridgeRecord.updateMany(
				{ _id: { $in: cartridgeIds } },
				{ $pull: { notes: { phase: 'reagent_prep' } } }
			),
			ReagentBatchRecord.updateOne(
				{ _id: runId },
				{ $pull: { notes: { phase: 'reagent_prep' } } }
			)
		]);
		await Promise.all([
			CartridgeRecord.updateMany(
				{ _id: { $in: cartridgeIds } },
				{ $push: { notes: noteEntry } }
			),
			ReagentBatchRecord.updateOne(
				{ _id: runId },
				{ $push: { notes: noteEntry } }
			)
		]);

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

			// Hard state-machine gate (WAX-SIMPLIFY-3): cartridge must be in the wax
			// stage — wax_filled or wax_ready — to enter reagent filling. Visual wax
			// pass is implicit; only wax_rejected carts are turned away. Same helper
			// as validate-equipment's live scan check so the two gates never disagree.
			// Applies to both research and production reagent runs.
			const notReady = (existingCartridges as any[])
				.map((c: any) => ({ c, gate: isReagentEligible(c.status) }))
				.filter((x) => !x.gate.ok);
			if (notReady.length > 0) {
				const details = notReady
					.map((x) => `${x.c._id} — ${(x.gate as { hint: string }).hint}`)
					.join('; ');
				return fail(400, {
					error: `Cartridge(s) can't be reagent-filled — must be wax_filled or wax_ready: ${details}`
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
			// The upsert below creates a stub for any scanned id that doesn't
			// exist yet — so a production bucket's label must be refused first,
			// or a tub's UUID QR sticker would be born as a cartridge
			// (BUCKET-SYSTEM_PLAN §9.4).
			const bucketLabels = await findBucketLabels(cartridgesFilled.map((cf: any) => cf.cartridgeId));
			if (bucketLabels.size > 0) {
				const details = [...bucketLabels].map(([code, b]) => `${code} is the label on bucket ${b}`).join('; ');
				return fail(400, { error: `Not cartridges — ${details}. Remove them from the deck scan.` });
			}
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

	/**
	 * Start the run — same three-step handshake as wax-filling startRun:
	 *   1. Coerce form params to native types via protocol's parametersSchema.
	 *   2. POST /runs on the robot.
	 *   3. POST /runs/<rid>/actions {actionType:'play'}.
	 *
	 * Stamp protocolParameters + opentronsRunId + pipetteTipState.before
	 * onto the ReagentBatchRecord. Status flips Loading→Running atomically
	 * with the OT-2 work.
	 */
	/**
	 * Start the run — the queue line's single action. Same guards, freshness gate
	 * (auto-resync when stale), create, play and records as before, now composed
	 * from the shared prepare → robot half (runVerb over the server transport) →
	 * confirm. The tailnet line runs the same steps via ?/startPrepare … ?/startConfirm.
	 */
	startRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const data = await request.formData();
		const r = await startRunQueue('reagent', data, { _id: locals.user._id, username: locals.user.username });
		if (isActionFail(r)) return fail(r.fail.status, { error: r.fail.error });
		return r;
	},

	/**
	 * Record the OT-2 run as finished (called by the client when the
	 * embedded controller observes terminal status). Stamps
	 * pipetteTipState.after and consumed onto the ReagentBatchRecord;
	 * does NOT advance the reagent state machine — the operator still
	 * clicks Complete (completeRunFilling) to finish the run.
	 */
	recordRunFinished: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const finalStatus = (data.get('finalStatus')?.toString() ?? '').toLowerCase();
		const r = await recordRunFinishedQueue('reagent', runId, finalStatus, { _id: locals.user._id, username: locals.user.username });
		if (isActionFail(r)) return fail(r.fail.status, { error: r.fail.error });
		return r;
	},

	/**
	 * Complete run filling (REAGENT-TOPSEAL-IMPLICIT) — see finalizeReagentRun
	 * for the actual work (run → Completed, carts → reagent_filled, tube +
	 * cut-sheet inventory). Since 2026-08-28 a succeeded run auto-finalizes in
	 * recordRunFinished / the load reconcile, so this button is usually just an
	 * idempotent confirm; it still commits non-succeeded runs on operator
	 * judgment and legacy runs finished before auto-complete shipped.
	 */
	completeRunFilling: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;

		// GUARD (2026-08-31): finalizing stamps every cartridge reagent_filled.
		// A run that ended in `failed` may not have dispensed anything at all —
		// B14 errored during tip calibration, before the first aspirate, and the
		// page still offered a green "batch completed / Done". Committing that
		// would push 20 unfilled cartridges downstream as filled. Require an
		// explicit acknowledgement for any non-succeeded run; the happy path
		// (recordRunFinished's auto-finalize, and Done after a clean run) is
		// untouched.
		const acknowledged = data.get('confirmDespiteFailure')?.toString() === 'true';
		const runDoc = (await ReagentBatchRecord.findById(runId)
			.select('opentronsRunFinalStatus cartridgesFilled').lean()) as any;
		const finalStatus = String(runDoc?.opentronsRunFinalStatus ?? '').toLowerCase();
		if (finalStatus && !['succeeded', 'completed'].includes(finalStatus) && !acknowledged) {
			return fail(400, {
				error:
					`This run ended in "${finalStatus}" — the robot may not have filled any cartridges. ` +
					`Completing it would mark all ${runDoc?.cartridgesFilled?.length ?? 0} as reagent-filled. ` +
					`Fix the cause and re-run them, or confirm explicitly if you have verified the reagent went in.`,
				requiresFailureAck: true
			});
		}

		// Normally a no-op confirm: recordRunFinished already finalized the run
		// the moment the .py succeeded. Still does the real work for runs that
		// ended in a non-succeeded state the operator EXPLICITLY commits (see
		// the guard above), and for legacy runs finished before auto-complete.
		const res = await finalizeReagentRun(
			runId,
			{ _id: locals.user._id, username: locals.user.username },
			'manual Complete'
		);
		if ('notFound' in res) return fail(404, { error: 'Run not found' });

		// Robot is now free and the run is terminal. The page's load function
		// will no longer find this run as "active", so invalidateAll() resets the
		// page to "Start new run". Next BIMS touch for these carts: Reagent Inspect.
		return { success: true };
	},

	/** Cancel a run — only available before the OT-2 finishes */
	cancelRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const reason = (data.get('reason') as string) || 'Cancelled by operator';
		// Halts the OT-2 first ('run.stop'), then records — see stopConfirm.
		const r = await stopRunQueue('reagent', 'cancel', runId, { reason }, { _id: locals.user._id, username: locals.user.username });
		if (isActionFail(r)) return fail(r.fail.status, { error: r.fail.error });
		return r;
	},

	/** Abort a run */
	abortRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const reason = (data.get('reason') as string) || 'Aborted';
		const photoUrl = (data.get('photoUrl') as string) || undefined;
		const r = await stopRunQueue('reagent', 'abort', runId, { reason, photoUrl }, { _id: locals.user._id, username: locals.user.username });
		if (isActionFail(r)) return fail(r.fail.status, { error: r.fail.error });
		return r;
	},

	// OT2-TAILNET-5 two-phase lifecycle (tailnet line): startPrepare, startBundle,
	// startRecordResync, startConfirm, finishConfirm, cancelConfirm, abortConfirm.
	...lifecycleActions('reagent'),

	/** Reset to deck loading — clear cartridges, go back to Loading */
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
				deckId: undefined,
				status: 'Loading'
			},
			$unset: { runStartTime: '', runEndTime: '' }
		});

		return { success: true };
	},

	/** Force advance to a specific stage (admin skip) */
	/**
	 * Mid-run tip swap (2026-09-18, mirrors wax-filling). Asks the on-robot
	 * bridge daemon to write a request file that the running reagent protocol
	 * polls before every aspiration batch. The protocol then swaps the tip
	 * (mode 'rack' = robot takes the next tracked tip; 'hand' = pauses for the
	 * operator to push one on), re-probes it on the calibrator, and continues
	 * with the batch it was about to aspirate. Works running or paused.
	 */
	requestTipSwap: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const data = await request.formData();
		const runId = data.get('runId')?.toString();
		const mode = data.get('mode')?.toString() === 'hand' ? 'hand' : 'rack';
		const cancel = data.get('cancel')?.toString() === 'true';
		if (!runId) return fail(400, { error: 'Missing runId' });
		const run = await ReagentBatchRecord.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });
		const robotId = run.robot?._id;
		const robot = robotId ? await OpentronsRobot.findById(robotId).lean() as any : null;
		if (!robot) return fail(400, { error: 'Run has no OT-2 robot' });
		try {
			await Ot2BridgeCommand.create({
				_id: generateId(),
				robotId: String(robotId),
				deviceId: bridgeDeviceIdForRobot(robot as any),
				kind: 'tip_swap_request',
				payload: { mode, cancel, runId: run.opentronsRunId ?? null, requestedBy: locals.user.username },
				ttlMs: 120_000,
				requestedBy: locals.user.username
			});
		} catch (e) {
			return fail(502, { error: `Could not reach the robot bridge: ${e instanceof Error ? e.message : 'unknown'}` });
		}
		await AuditLog.create({
			_id: generateId(),
			tableName: 'reagent_batch_records',
			recordId: runId,
			action: cancel ? 'reagent_tip_swap_cancel' : 'reagent_tip_swap_request',
			changedBy: locals.user.username,
			changedAt: new Date(),
			newData: { mode, cancel, opentronsRunId: run.opentronsRunId ?? null, robotId: String(robotId) }
		});
		return { success: true, tipSwap: cancel ? 'cancelled' : mode };
	},

	forceAdvanceStage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const targetStage = data.get('targetStage') as string;

		const validStages = ['Setup', 'Loading', 'Running'];
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
