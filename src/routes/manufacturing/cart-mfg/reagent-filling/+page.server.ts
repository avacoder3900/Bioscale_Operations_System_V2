import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, ReagentBatchRecord, AssayDefinition, CartridgeRecord, Consumable,
	ManufacturingSettings, WaxFillingRun, Equipment, EquipmentLocation, generateId, AuditLog,
	ReagentLot,
	OpentronsRobot, Ot2BridgeCommand
} from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import { checkRobotConflict, checkDeckConflict, checkTrayConflict } from '$lib/server/manufacturing/resource-locks';
import { WAX_PAGE_OWNED } from '$lib/server/manufacturing/run-statuses';
import { getRobot, robotGet, robotPost, bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';
import { calibrationRtpValues } from '$lib/server/opentrons/calibration-rtps';
import { ensureFreshRunProtocol } from '$lib/server/opentrons/protocol-freshness';
import { resolveDeckBinding, DeckBindingError } from '$lib/server/services/deck-calibration/run-guard';
import { isHardenedRobot } from '$lib/server/services/deck-calibration/rollout';
import { OpentronsRunRecord } from '$lib/server/db';
import { estimateReagentRunSeconds } from '$lib/manufacturing/reagent-run-estimate';
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
			protocolParameters: null as Record<string, unknown> | null
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
				protocolParameters: activeRun.protocolParameters ?? null
			}
			: { hasActiveRun: false, stage: null, assayTypeName: null, assayTypeId: null, isResearch: false, cartridgeCount: 0, runStartTime: null, runEndTime: null, opentronsRunId: null, opentronsRunFinalStatus: null, protocolParameters: null };

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

/**
 * Best-effort stop of the OT-2 run backing a reagent run, BEFORE marking it
 * aborted/cancelled in BIMS. Without this the UI exited but the robot kept
 * running. Resilient: never-started, already-terminal, or unreachable cases
 * don't block the operator. Returns a warning string when the stop couldn't be
 * confirmed, else null. `run` must be selected with `opentronsRunId` + `robot`.
 */
async function stopRobotRun(run: any): Promise<string | null> {
	const opentronsRunId: string | undefined = run?.opentronsRunId;
	const robotId: string | undefined = run?.robot?._id;
	if (!opentronsRunId || !robotId) return null; // never started on a robot

	try {
		const robot = await getRobot(robotId);
		if (!robot) return `Robot ${robotId} is offline — confirm the run is stopped on the device.`;
		const res = await robotPost(robot, `/runs/${opentronsRunId}/actions`, {
			data: { actionType: 'stop' }
		});
		if (res.ok) return null;
		const body = await res.json().catch(() => ({}));
		const detail = (body as any)?.errors?.[0]?.detail ?? `robot returned ${res.status}`;
		if (res.status === 404 || res.status === 409 || /not found|not allowed|terminal/i.test(String(detail))) {
			return null;
		}
		return `Couldn't stop the run on the robot (${detail}) — confirm on the device.`;
	} catch (e) {
		return `Couldn't reach the robot to stop the run (${e instanceof Error ? e.message : 'unknown'}) — confirm on the device.`;
	}
}

/**
 * Statuses a cartridge can legitimately hold while it waits for its reagent
 * fill to be recorded. finalizeReagentRun only advances `status` from these —
 * a cart that has already moved on (linked into a research experiment,
 * underway, completed) keeps its status and only gains the reagentFilling
 * stamp. Guards against a deferred completion regressing live experiment
 * carts (2026-08-28: a Complete clicked 2h after the run knocked 22
 * experiment-350 carts from linked/tested back to reagent_filled).
 */
const PRE_REAGENT_STATUSES = ['backing', 'wax_filled', 'wax_qc', 'wax_ready', 'wax_stored'];

/**
 * Finalize a reagent run (REAGENT-TOPSEAL-IMPLICIT): run → Completed, robot
 * released, cartridges stamped reagent_filled, tube + top-seal inventory
 * consumed. Idempotent — callable from recordRunFinished (auto, the moment
 * the .py succeeds), the load-time reconcile, and the manual Complete button.
 */
async function finalizeReagentRun(
	runId: string,
	user: { _id: string; username: string },
	trigger: string
): Promise<{ ok: true } | { notFound: true }> {
	const now = new Date();

	// Idempotency: auto-complete, load reconcile, and the button can race.
	const existing = await ReagentBatchRecord.findById(runId).select('status finalizedAt').lean() as any;
	if (!existing) return { notFound: true };
	if (existing.status === 'Completed' || existing.finalizedAt) return { ok: true };

	const run = await ReagentBatchRecord.findByIdAndUpdate(runId, {
		$set: {
			status: 'Completed',
			finalizedAt: now,
			runEndTime: now,
			// Robot is physically free as of now — releases the robot lock so
			// the next wax/reagent run can start.
			robotReleasedAt: now
		}
	}, { new: true }).lean() as any;

	// Write reagentFilling phase to cartridges (WRITE-ONCE). Research runs
	// leave assayType null on each cartridge — downstream UIs must treat
	// reagentFilling.isResearch === true as "assay intentionally blank".
	if (run?.cartridgesFilled?.length) {
		const isResearch = run.isResearch === true;
		const bulkOps = run.cartridgesFilled.flatMap((cf: any) => {
			const stamp = {
				'reagentFilling.runId': run._id,
				'reagentFilling.robotId': run.robot?._id,
				'reagentFilling.robotName': run.robot?.name,
				'reagentFilling.assayType': isResearch ? null : run.assayType,
				'reagentFilling.isResearch': isResearch,
				'reagentFilling.deckPosition': cf.deckPosition,
				'reagentFilling.tubeRecords': run.tubeRecords,
				'reagentFilling.operator': run.operator,
				'reagentFilling.fillDate': now,
				'reagentFilling.recordedAt': now
			};
			return [
				{
					updateOne: {
						filter: {
							_id: cf.cartridgeId,
							'reagentFilling.recordedAt': { $exists: false },
							status: { $in: PRE_REAGENT_STATUSES }
						},
						update: { $set: { ...stamp, status: 'reagent_filled' } }
					}
				},
				// Cart already moved past the fill (e.g. linked into a research
				// experiment while the run sat unfinalized): record the fill
				// data but leave its status alone.
				{
					updateOne: {
						filter: {
							_id: cf.cartridgeId,
							'reagentFilling.recordedAt': { $exists: false },
							status: { $nin: PRE_REAGENT_STATUSES }
						},
						update: { $set: stamp }
					}
				}
			];
		});
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

		// Consume top-seal cut sheets (PT-CT-113) — implicit top seal. One
		// sheet seals up to `topSealCutting.cartridgesPerSheet` carts (default
		// 12); partial sheets count as fully consumed. This used to happen per
		// seal batch on the (now removed) Top Sealing step; deducting at fill
		// completion may slightly over-count when operators split batches,
		// which is acceptable (decision 2026-08-19 — cut sheets are cheap).
		// No lot linkage: the sheet lot is no longer scanned.
		const cutSheetPartId = await resolvePartId('PT-CT-113');
		if (cutSheetPartId) {
			const settingsDoc = await ManufacturingSettings.findById('default').lean().catch(() => null) as any;
			const perSheet = Math.max(1, Number(settingsDoc?.topSealCutting?.cartridgesPerSheet ?? 12));
			const sheets = Math.ceil(run.cartridgesFilled.length / perSheet);
			await recordTransaction({
				transactionType: 'consumption',
				partDefinitionId: cutSheetPartId,
				quantity: sheets,
				manufacturingStep: 'top_seal',
				manufacturingRunId: String(run._id),
				operatorId: run.operator?._id,
				operatorUsername: run.operator?.username,
				notes: `Reagent filling run complete — ${sheets} top-seal cut sheet(s) for ${run.cartridgesFilled.length} cartridges (implicit top seal, ${perSheet}/sheet)`
			});
		}
	}

	// Deck usage log (was in the old completeRun action on Opentron Control).
	if (run?.deckId) {
		const cartridgeCount = run?.cartridgesFilled?.length ?? 0;
		await Equipment.findByIdAndUpdate(run.deckId, {
			$set: { lastUsed: now },
			$push: {
				usageLog: {
					_id: generateId(),
					usageType: 'run_complete', runId: run._id,
					quantityChanged: cartridgeCount,
					operator: { _id: user._id, username: user.username },
					notes: `Reagent filling run complete — ${cartridgeCount} cartridges filled`,
					createdAt: now
				}
			}
		}).catch((e: unknown) => console.error('[reagent-filling] deck usageLog failed:', e));
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'reagent_batch_records',
		recordId: runId,
		action: 'UPDATE',
		changedBy: user.username,
		changedAt: now,
		newData: { status: 'Completed', cartridgeStatus: 'reagent_filled', trigger }
	});

	return { ok: true };
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
	startRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const opentronsProtocolId = data.get('opentronsProtocolId')?.toString();
		if (!runId) return fail(400, { error: 'runId is required' });
		if (!opentronsProtocolId) return fail(400, { error: 'opentronsProtocolId is required (pick a protocol)' });

		const run = await ReagentBatchRecord.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Reagent run not found' });
		const robotId = run.robot?._id;
		if (!robotId) return fail(400, { error: 'Reagent run has no robot assigned' });

		const robot = await getRobot(robotId);
		if (!robot) return fail(404, { error: `Robot ${robotId} not found / not active` });

		// Deck identity guard. BIMS knows which deck the operator selected; the
		// robot picks its cartridge-deck definition independently, from a Particle
		// id it reads over serial. Prove the selected deck is actually bound to a
		// real definition before moving a pipette — an unbound or dangling deck is
		// how a calibrated deck ends up filling at someone else's coordinates.
		let deckBinding;
		try {
			deckBinding = await resolveDeckBinding(run?.deckId ?? null, {
				enforce: isHardenedRobot(robot)
			});
		} catch (e) {
			if (e instanceof DeckBindingError) return fail(400, { error: e.message });
			throw e;
		}
		if (deckBinding.warning) console.warn('[reagent-filling startRun] ' + deckBinding.warning);


		// Freshness gate: resolve the robot's CURRENT reagent protocol server-side
		// and prove its bundled deck calibration matches live Mongo; auto-resync if
		// not. The posted opentronsProtocolId is intentionally NOT trusted — a page
		// loaded before a Sync would post the older upload, which still exists on
		// the robot and would silently run stale geometry.
		let protocol: { opentronsProtocolId: string; parametersSchema: any[] | null };
		try {
			protocol = await ensureFreshRunProtocol(robot, String(robotId), 'reagent-filling', locals.user.username);
		} catch (e) {
			return fail(502, {
				error: `Deck-calibration freshness check failed: ${e instanceof Error ? e.message : 'unknown'}`
			});
		}
		const runProtocolId = protocol.opentronsProtocolId;

		const paramSchema = (protocol.parametersSchema ?? []) as Array<{
			variableName: string;
			type?: 'int' | 'float' | 'bool' | 'str';
			default?: unknown;
		}>;

		const runTimeParameterValues: Record<string, number | string | boolean> = {};
		const protocolParameters: Record<string, number | string | boolean> = {};
		for (const def of paramSchema) {
			const raw = data.get(`param_${def.variableName}`);
			if (raw === null) {
				if (def.default !== undefined && def.default !== null) {
					runTimeParameterValues[def.variableName] = def.default as any;
					protocolParameters[def.variableName] = def.default as any;
				}
				continue;
			}
			let value: number | string | boolean;
			const s = raw.toString();
			if (def.type === 'bool') value = s === 'true' || s === 'on';
			else if (def.type === 'int') value = parseInt(s, 10);
			else if (def.type === 'float') value = parseFloat(s);
			else value = s;
			runTimeParameterValues[def.variableName] = value;
			protocolParameters[def.variableName] = value;
		}

		// PRD 6: inject BIMS-native calibration params (global offset + calibrator
		// point) for robots with a captured offset. No-op for the pre-cutover .py.
		// Deck-keyed calibrator (2026-08-28): the fixture is bolted to the carriage,
		// so the run gets the point taught for the deck that is physically mounted —
		// deckBinding.particleDeviceId is the same id the .py reads at run start.
		const calRtps = await calibrationRtpValues(String(robotId), 'reagent-filling', paramSchema as any, {
			deckKey: deckBinding.particleDeviceId,
			deckLoadName: deckBinding.deckLoadName
		});
		Object.assign(runTimeParameterValues, calRtps);
		Object.assign(protocolParameters, calRtps);

		// Create the OT-2 run.
		let opentronsRunId: string;
		try {
			const createRes = await robotPost(robot, '/runs', {
				data: {
					protocolId: runProtocolId,
					...(Object.keys(runTimeParameterValues).length ? { runTimeParameterValues } : {})
				}
			});
			if (!createRes.ok) {
				const body = await createRes.json().catch(() => ({}));
				const detail = (body as any).errors?.[0]?.detail ?? `Robot returned ${createRes.status}`;
				return fail(502, { error: `Couldn't create run on robot: ${detail}` });
			}
			const createBody = await createRes.json();
			opentronsRunId = createBody?.data?.id;
			if (!opentronsRunId) return fail(502, { error: 'Robot returned no run id' });

		// Geometry provenance. Record exactly which deck definition, at which
		// version and content hash, this run was started against — the definition
		// is edited in place, so these coordinates stop existing the moment anyone
		// jogs the deck again.
		try {
			await OpentronsRunRecord.create({
				_id: generateId(),
				manufacturingRunId: String(runId),
				manufacturingRunType: 'reagent-filling',
				robotId: String(robotId),
				robotName: robot.name ?? null,
				opentronsRunId,
				opentronsProtocolId: runProtocolId,
				runtimeParameters: runTimeParameterValues,
				deckGeometry: deckBinding,
				status: 'created',
				robotCreatedAt: new Date(),
				startedBy: locals.user.username
			});
		} catch (e) {
			// Provenance must never block a fill that the robot already accepted.
			console.error('[reagent-filling startRun] could not write run record:', e instanceof Error ? e.message : e);
		}
		} catch (err) {
			return fail(502, {
				error: `Couldn't reach robot: ${err instanceof Error ? err.message : 'unknown'}`
			});
		}

		// Start execution.
		try {
			const playRes = await robotPost(robot, `/runs/${opentronsRunId}/actions`, {
				data: { actionType: 'play' }
			});
			if (!playRes.ok) {
				const body = await playRes.json().catch(() => ({}));
				const detail = (body as any).errors?.[0]?.detail ?? `Robot returned ${playRes.status}`;
				return fail(502, {
					error: `Created run ${opentronsRunId} but couldn't start it: ${detail}.`
				});
			}
		} catch (err) {
			return fail(502, {
				error: `Created run ${opentronsRunId} but couldn't start it: ${err instanceof Error ? err.message : 'unknown'}`
			});
		}

		// Auto-resume the protocol's initial off-deck "confirm deck loaded" pause
		// on the robot — operators shouldn't have to click Resume to confirm a
		// deck that's already loaded. Fire-and-forget; the daemon resumes the
		// first pause once. (Mirrors wax-filling startRun.)
		try {
			await Ot2BridgeCommand.create({
				_id: generateId(),
				robotId: String(robotId),
				deviceId: bridgeDeviceIdForRobot(robot as any),
				kind: 'auto_resume_run',
				payload: { runId: opentronsRunId },
				ttlMs: 120_000,
				requestedBy: locals.user.username
			});
		} catch (e) {
			console.warn('[reagent startRun] could not enqueue auto_resume_run:', e instanceof Error ? e.message : e);
		}

		// Carry previous reagent run's tip state forward as this run's "before".
		const prevTipRun = await ReagentBatchRecord.findOne({
			'robot._id': robotId,
			'pipetteTipState.after.nextTipIndex': { $exists: true },
			_id: { $ne: runId }
		}).sort({ runEndTime: -1 }).select('pipetteTipState').lean() as any;

		const refilled = protocolParameters.tiprack_refilled === true;
		const beforeSnap = refilled
			? { nextTipIndex: 0, hostname: prevTipRun?.pipetteTipState?.after?.hostname ?? null, capturedAt: new Date() }
			: prevTipRun?.pipetteTipState?.after
				? {
					nextTipIndex: prevTipRun.pipetteTipState.after.nextTipIndex ?? 0,
					hostname: prevTipRun.pipetteTipState.after.hostname ?? null,
					capturedAt: new Date()
				}
				: { nextTipIndex: 0, hostname: null, capturedAt: new Date() };

		// Estimated finish time. Driven by how many wells the selected reagent rows
		// will actually fill, not by cartridge count alone — see
		// src/lib/manufacturing/reagent-run-estimate.ts for the model and the fit.
		const settingsDoc = await ManufacturingSettings.findById('default').lean() as any;
		const cartridgeCount = run.cartridgeCount ?? run.cartridgesFilled?.length ?? 0;
		const estimate = estimateReagentRunSeconds(
			protocolParameters,
			cartridgeCount,
			settingsDoc?.reagentFilling
		);
		const runStartTime = new Date();
		const runEndTime = new Date(runStartTime.getTime() + estimate.seconds * 1000);

		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: {
				status: 'Running',
				runStartTime,
				runEndTime,
				opentronsRunId,
				protocolParameters,
				'pipetteTipState.before': beforeSnap,
				'pipetteTipState.rackRefilledDuringRun': refilled
			}
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'reagent_batch_records',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: runStartTime,
			newData: {
				status: 'Running',
				runStartTime,
				opentronsRunId,
				protocolParameters,
				pipetteTipBefore: beforeSnap.nextTipIndex
			}
		});

		return { success: true, opentronsRunId };
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
		if (!runId) return fail(400, { error: 'runId is required' });

		const run = await ReagentBatchRecord.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Reagent run not found' });
		if (!run.opentronsRunId) return fail(400, { error: 'This reagent run has no OT-2 run linked' });
		if (run.pipetteTipState?.after?.nextTipIndex != null) {
			return { success: true, alreadyRecorded: true };
		}

		const robot = await getRobot(run.robot?._id);
		if (!robot) return fail(404, { error: 'Robot no longer reachable' });

		let nextTipIndex: number | null = null;
		let pickUpTipCount = 0;
		try {
			const cmdRes = await robotGet(
				robot,
				`/runs/${run.opentronsRunId}/commands?cursor=0&pageLength=10000`
			);
			if (cmdRes.ok) {
				const cmdBody = await cmdRes.json();
				const commands = (cmdBody.data ?? []) as Array<{
					commandType: string;
					params?: { message?: string };
				}>;
				for (const cmd of commands) {
					if (cmd.commandType === 'pickUpTip') pickUpTipCount += 1;
					if (cmd.commandType === 'comment' && cmd.params?.message) {
						const m = cmd.params.message.match(/TIP TRACKER:[\s\S]*?\(index (\d+)\)/);
						if (m) nextTipIndex = parseInt(m[1], 10);
					}
				}
			}
		} catch (err) {
			console.error('[REAGENT-FILLING] recordRunFinished: command fetch failed:', err);
		}

		const now = new Date();
		const before = run.pipetteTipState?.before?.nextTipIndex ?? 0;
		const refilledMidRun = !!run.pipetteTipState?.rackRefilledDuringRun;
		const finalIndex = nextTipIndex ?? before + pickUpTipCount;
		const consumed = refilledMidRun
			? Math.max(0, 96 - before) + finalIndex
			: Math.max(0, finalIndex - before);

		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: {
				// Persist the terminal .py status on the run so the Running stage can
				// reveal the Complete + Run-again controls after the protocol finishes.
				opentronsRunFinalStatus: finalStatus || 'unknown',
				'pipetteTipState.after': {
					nextTipIndex: finalIndex,
					hostname: run.pipetteTipState?.before?.hostname ?? null,
					capturedAt: now
				},
				'pipetteTipState.consumed': consumed
			}
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'reagent_batch_records',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: {
				opentronsRunFinalStatus: finalStatus || 'unknown',
				pipetteTipAfter: finalIndex,
				pipetteTipConsumed: consumed
			}
		});

		// AUTO-COMPLETE (2026-08-28, parity with wax): a reagent run that lands
		// `succeeded` IS done — finalize immediately so the robot frees the
		// moment the .py finishes instead of waiting for a Complete click. A
		// deferred click used to hold the robot AND restamp carts hours later
		// over statuses they'd gained in a research experiment meanwhile.
		// Stopped/failed runs are left Running for cancel/abort.
		if (finalStatus === 'succeeded') {
			await finalizeReagentRun(
				runId,
				{ _id: locals.user._id, username: locals.user.username },
				'auto (run finished)'
			);
		}

		return { success: true, consumed, nextTipIndex: finalIndex, autoCompleted: finalStatus === 'succeeded' };
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
		const now = new Date();

		// Once the OT-2 has finished (robotReleasedAt set), the run is committed
		// and can no longer be cancelled. Per-cartridge rejection happens later
		// on the Reagent Inspect page.
		const existing = await ReagentBatchRecord.findById(runId).select('robotReleasedAt opentronsRunId robot').lean() as any;
		if (existing?.robotReleasedAt) {
			return fail(400, { error: 'Cannot cancel: the OT-2 has already completed this run. Reject individual cartridges on Reagent Inspect instead.' });
		}

		// Actually halt the OT-2 first — otherwise the robot keeps running.
		const cancelRobotWarning = await stopRobotRun(existing);

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

		return { success: true, warning: cancelRobotWarning ?? undefined };
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

		// Actually halt the OT-2 first — otherwise the robot keeps running.
		const abortTarget = await ReagentBatchRecord.findById(runId).select('opentronsRunId robot').lean() as any;
		const abortRobotWarning = await stopRobotRun(abortTarget);

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

		return { success: true, warning: abortRobotWarning ?? undefined };
	},

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
