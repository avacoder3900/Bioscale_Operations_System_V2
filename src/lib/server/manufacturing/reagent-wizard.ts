/**
 * Reagent wizard load (ROBOT-OVERHAUL round 2, 2026-10-07). This WAS the load
 * of reagent-filling/+page.server.ts, unchanged except for its inputs: the
 * Robots page calls it once per robot whose reagent panel is open. The actions
 * stay on the reagent-filling route.
 */
import { redirect } from '@sveltejs/kit';
import {
	connectDB, ReagentBatchRecord, AssayDefinition, ManufacturingSettings, WaxFillingRun,
	Equipment, EquipmentLocation, generateId, ReagentLot, OpentronsRobot, ReagentSetLot, FillLot
} from '$lib/server/db';
import { WAX_PAGE_OWNED } from './run-statuses';
import { getRobot, robotGet } from '$lib/server/opentrons/proxy';
import { requirePermission } from '$lib/server/permissions';
import {
	finalizeReagentRun,
	reconcileStartIntent,
	setRunRecordStatus
} from '$lib/server/opentrons/run-lifecycle-records';
import type { ReagentWellIssueRow } from '$lib/manufacturing/reagent-well-issues';

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
		researchReagentLots: [] as any[],
		openFillLots: [] as any[],
		defaultFillLotId: '',
		fillLotNumber: null as string | null,
		reagentLotNumber: null as string | null,
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
		},
		wellIssues: [] as ReagentWellIssueRow[]
	};
}

/** Run-page tracker rows, plain and ISO-dated (SvelteKit-serializable). */
export function serializeWellIssues(raw: any[] | undefined | null): ReagentWellIssueRow[] {
	return (raw ?? []).map((w: any) => ({
		id: String(w._id),
		deckPosition: Number(w.deckPosition),
		cartridgeId: w.cartridgeId ?? null,
		well: Number(w.well),
		reagentName: w.reagentName ?? null,
		issue: String(w.issue ?? 'other'),
		note: w.note ?? null,
		loggedBy: w.loggedBy?.username ?? null,
		loggedAt: w.loggedAt ? new Date(w.loggedAt).toISOString() : null
	}));
}

export async function loadReagentWizard(locals: App.Locals, robotId: string) {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'reagentFilling:read');


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

		// Operator-logged per-well fill mistakes (run-page tracker).
		const wellIssues = serializeWellIssues(activeRun?.wellIssues);

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
		// DOMAIN-32: research reagent lots (reagent_set_lots) — needed to open a new fill lot.
		const researchReagentLots = await ReagentSetLot.find({ status: 'active' }).select('_id lotNumber name assayId components createdAt').sort({ createdAt: -1 }).lean();
		// Open fill lots (fill_lots): the operator picks one per run; runs default to the one used last.
		const openFillLots = await FillLot.find({ status: 'open', fillLotNumber: { $nin: [null, ''] } }).select('_id fillLotNumber name reagentLotId reagentLotNumber runIds fillDate updatedAt').sort({ updatedAt: -1 }).lean();
		const lastWithFillLot = await ReagentBatchRecord.findOne({ fillLotId: { $nin: [null, ''] } }).select('fillLotId').sort({ createdAt: -1 }).lean() as any;
		const defaultFillLotId = (activeRun as any)?.fillLotId ?? lastWithFillLot?.fillLotId ?? (openFillLots[0] as any)?._id ?? '';
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
			researchReagentLots: JSON.parse(JSON.stringify(researchReagentLots)),
			openFillLots: JSON.parse(JSON.stringify(openFillLots)),
			defaultFillLotId: String(defaultFillLotId ?? ''),
			fillLotNumber: (activeRun as any)?.fillLotNumber ?? null,
			reagentLotNumber: (activeRun as any)?.reagentLotNumber ?? null,
			// --- OT-2 Start Run panel inputs (same shape as wax-filling) ---
			robotProtocols,
			opentronsRobotId: robotId,
			lastTipState,
			wellIssues
		};
	} catch (err) {
		console.error('[REAGENT-FILLING PAGE] Load error:', err instanceof Error ? err.message : err);
		// Return safe defaults — do NOT throw; let the page display an error message
		return emptyReagentState(robotId, 'Failed to load reagent filling data. Please refresh the page.');
	}
}

export type ReagentWizardData = Awaited<ReturnType<typeof loadReagentWizard>>;
