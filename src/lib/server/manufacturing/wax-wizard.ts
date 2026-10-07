/**
 * Wax wizard load (ROBOT-OVERHAUL round 2, 2026-10-07). This WAS the load of
 * wax-filling/+page.server.ts, unchanged except for its inputs: the Robots page
 * calls it once per robot whose wax panel is open, so every robot's wizard can
 * be on screen at the same time. The actions stay on the wax-filling route.
 */
import { redirect } from '@sveltejs/kit';
import {
	connectDB, WaxFillingRun, CartridgeRecord, Consumable, ManufacturingSettings,
	Equipment, EquipmentLocation, WaxBatch, ReceivingLot, OpentronsRobot,
	TipCalibratorFixture, BucketCycle, ReagentBatchRecord
} from '$lib/server/db';
import { BACKED_STAGE, BACKED_LABEL } from '$lib/server/services/bucket-service';
import { getRobot, robotGet } from '$lib/server/opentrons/proxy';
import { requirePermission } from '$lib/server/permissions';
import {
	advanceCartsToWaxFilled,
	reconcileStartIntent,
	setRunRecordStatus
} from '$lib/server/opentrons/run-lifecycle-records';

export const WAX_TUBE_PART_NUMBER = 'PT-CT-114'; // purchased 15ml wax tubes (ReceivingLot source)

/** Map DB status → UI stage string (STAGES const in svelte) */
function toStage(status: string | null | undefined): string | null {
	if (!status) return null;
	const map: Record<string, string> = {
		// Setup stage removed (WAX-FLOW-3) — stale Setup runs land on Loading
		setup: 'Loading', Setup: 'Loading',
		loading: 'Loading', Loading: 'Loading',
		running: 'Running', Running: 'Running',
		awaiting_removal: 'Awaiting Removal', 'Awaiting Removal': 'Awaiting Removal',
		cooling: 'Awaiting Removal',
		qc: 'QC', QC: 'QC',
		storage: 'Storage', Storage: 'Storage'
	};
	return map[status] ?? null;
}

// Stages where the operator is still working the run on THIS page — the
// robot stays locked until status moves past 'Awaiting Removal' (i.e. until
// the final "Confirm — Deck Placed in Oven" click transitions to QC). From
// QC onward the run lives on the Opentron Control post-OT-2 queue.
const PAGE_OWNED_STAGES = new Set(['Setup', 'Loading', 'Running', 'Awaiting Removal',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling']);
const REAGENT_PAGE_OWNED_STAGES = new Set(['Setup', 'Loading', 'Running', 'Inspection',
	'setup', 'loading', 'running', 'inspection']);

/** Safe-default empty state for error fallback */
function emptyState(robotId: string, loadError: string | null = null) {
	return {
		robotId,
		robotName: 'Wax Filling',
		loadError,
		robotBlocked: null as { process: 'reagent'; runId: string | null } | null,
		runState: {
			hasActiveRun: false, runId: null, stage: null,
			runStartTime: null, runEndTime: null,
			deckRemovedTime: null as string | null, coolingConfirmedAt: null as string | null, existingWaxRunNote: '',
			deckId: null, waxSourceLot: null, coolingTrayId: null, plannedCartridgeCount: null,
			opentronsRunId: null as string | null,
			opentronsRunFinalStatus: null as string | null,
			protocolParameters: null as Record<string, unknown> | null,
			startInterrupted: null as string | null
		},
		settings: {
			runDurationMin: 45, removeDeckWarningMin: 5, coolingWarningMin: 7,
			deckLockoutMin: 25, incubatorTempC: 37, heaterTempC: 65,
			minCoolingBeforeQcMin: 2, waxPerCartridgeUl: 19.2, waxFillDeadVolumeUl: 80
		},
		tubeData: null as null | {
			tubeId: string; initialVolumeUl: number; remainingVolumeUl: number;
			status: string; totalCartridgesFilled: number; totalRunsUsed: number;
		},
		backedOvens: [] as { ovenId: string; ovenName: string; total: number; ready: number }[],
		backedReadyCount: 0,
		backedTotalCount: 0,
		backedBuckets: [] as { bucketId: string; cycleNumber: number; count: number; backedAt: string | null }[],
		backedLabel: BACKED_LABEL,
		waxLots: [] as { barcode: string; label: string; remainingVolumeUl: number; source: string }[],
		rejectionCodes: [] as any[],
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
		// Per-robot wax-tube aspiration floor (fixture.minTipClearanceWaxMm), for DISPLAY
		// on the parameters form. The value that runs is injected server-side at
		// startRun by calibrationRtpValues regardless of what the form shows.
		waxFloorMm: null as number | null
	};
}

export async function loadWaxWizard(locals: App.Locals, robotId: string, robotName = 'Wax Filling') {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'waxFilling:read');

	if (!robotId) return emptyState('', 'No robots configured. Add a robot in equipment settings.');

	try {
		await connectDB();

		// Load everything in parallel.
		// Both active-run queries gate on robotReleasedAt: only runs where the
		// OT-2 hasn't finished yet count as "robot in use". Post-OT-2 runs live
		// on Opentron Control and don't lock the robot.
		const [activeWaxRun, settingsDoc, activeTube, activeReagentRunRaw, robotDoc, lastTipRun] = await Promise.all([
			// This page owns Setup → Awaiting Removal. After confirmCooling
			// advances status to QC the run lives on Opentron Control, so
			// activeWaxRun here is scoped to page-owned stages only.
			WaxFillingRun.findOne({
				'robot._id': robotId,
				status: { $in: [...PAGE_OWNED_STAGES] }
			}).sort({ createdAt: -1 }).lean(),
			ManufacturingSettings.findById('default').lean(),
			Consumable.findOne({ type: 'incubator_tube', status: 'active' }).lean(),
			// A reagent run on the same robot blocks wax only while it's in
			// reagent-filling-page-owned stages (Setup → Inspection). Once it
			// passes Inspection it's on the Opentron Control queue and the
			// robot is free for a new wax run.
			ReagentBatchRecord.findOne({
				'robot._id': robotId,
				status: { $in: [...REAGENT_PAGE_OWNED_STAGES] }
			}).lean().catch(() => null),
			// Robot's uploaded protocols + parameter schemas — the Start Run
			// panel renders the parameter form from these. Mongoose returns
			// the protocols subdoc array along with the rest of the doc.
			OpentronsRobot.findById(robotId).lean().catch(() => null),
			// Most recent wax run on this robot whose OT-2 completion was
			// captured. Feeds the tip-tracker readout pre-run.
			WaxFillingRun.findOne({
				'robot._id': robotId,
				'pipetteTipState.after.nextTipIndex': { $exists: true }
			}).sort({ runEndTime: -1 }).select('pipetteTipState').lean().catch(() => null)
		]);

		const wax = (settingsDoc as any)?.waxFilling ?? {};
		const rejectionCodes = ((settingsDoc as any)?.rejectionReasonCodes ?? [])
			.filter((r: any) => !r.processType || r.processType === 'wax')
			.map((r: any, i: number) => ({
				id: r._id ? String(r._id) : String(i), code: r.code ?? '', label: r.label ?? '',
				processType: r.processType ?? 'wax', sortOrder: r.sortOrder ?? i
			}));

		let run = activeWaxRun as any;
		// Two-phase start (OT2-TAILNET-5): a start whose page died between "robot
		// started" and "confirm" left startIntent set. Find the robot's run and
		// confirm it, or clear the intent once nothing can still be in flight.
		let startInterrupted: string | null = null;
		if (run?.startIntent?.token) {
			const rec = await reconcileStartIntent('wax', run, { _id: locals.user!._id, username: locals.user!.username });
			startInterrupted = rec.banner;
			if (rec.changed) run = (await WaxFillingRun.findById(run._id).lean()) as any;
		}
		// SELF-HEAL (2026-08-28): if the robot finished cleanly while nobody had
		// the page open, advance + complete on the next visit — the carts must
		// not depend on a browser tab having been alive at the moment the run
		// ended. Best-effort; failures leave the run for the normal flow.
		if (run && run.status === 'Running' && run.opentronsRunId && !run.opentronsRunFinalStatus) {
			try {
				const rRobot = await getRobot(run.robot?._id);
				if (rRobot) {
					const rs = await robotGet(rRobot, `/runs/${run.opentronsRunId}`);
					if (rs.ok) {
						const st = ((await rs.json())?.data?.status ?? '').toLowerCase();
						if (st === 'succeeded') {
							const user = { _id: locals.user!._id, username: locals.user!.username };
							await advanceCartsToWaxFilled(run, run.cartridgeIds ?? [], user, 'run-complete auto-advance (load reconcile)');
							await WaxFillingRun.findByIdAndUpdate(run._id, {
								$set: { status: 'completed', opentronsRunFinalStatus: 'succeeded', robotReleasedAt: new Date(), runEndTime: new Date() }
							});
							await setRunRecordStatus(String(run._id), run.opentronsRunId, 'succeeded');
							run = null; // page renders idle — run is done
						}
					}
				}
			} catch (e) {
				console.error('[wax load] run reconcile failed:', e instanceof Error ? e.message : e);
			}
		}

		const stage = run ? toStage(run.status) : null;

		// Existing wax_run note body, if the operator has already saved one on
		// this run — pre-populates the textarea on reload so they can keep
		// editing without losing context.
		const existingWaxRunNote = run
			? ((run.notes ?? []).find((n: any) => n.phase === 'wax_run')?.body ?? '')
			: '';

		// Build runState
		const runState = run
			? {
				hasActiveRun: true,
				runId: String(run._id),
				stage,
				runStartTime: run.runStartTime ? new Date(run.runStartTime).toISOString() : null,
				runEndTime: run.runEndTime ? new Date(run.runEndTime).toISOString() : null,
				deckRemovedTime: run.deckRemovedTime ? new Date(run.deckRemovedTime).toISOString() : null,
				deckId: run.deckId ?? null,
				waxSourceLot: run.waxSourceLot ?? null,
				coolingTrayId: run.coolingTrayId ?? null,
				plannedCartridgeCount: run.plannedCartridgeCount ?? run.cartridgeIds?.length ?? null,
				coolingConfirmedAt: run.coolingConfirmedTime ? new Date(run.coolingConfirmedTime).toISOString() : null,
				existingWaxRunNote,
				// OT-2 linkage — set by startRun once the protocol run is created
				// on the robot. Absent during Setup/Loading; present once Running.
				opentronsRunId: run.opentronsRunId ?? null,
				// Final status of the OT-2 .py once it lands terminal (stamped by
				// recordRunFinished). Lets the page show the deck-removal
				// confirmation only after the protocol completes, even on reload.
				opentronsRunFinalStatus: run.opentronsRunFinalStatus ?? null,
				// Mirror the parameter set the operator chose for this run so the
				// page can show "what we asked the robot to do" after the fact.
				protocolParameters: run.protocolParameters ?? null,
				// "start interrupted — check robot" (a start intent older than 10 min).
				startInterrupted
			}
			: { hasActiveRun: false, runId: null, stage: null, runStartTime: null, runEndTime: null, deckRemovedTime: null, deckId: null, waxSourceLot: null, coolingTrayId: null, plannedCartridgeCount: null, coolingConfirmedAt: null, existingWaxRunNote: '', opentronsRunId: null, opentronsRunFinalStatus: null, protocolParameters: null, startInterrupted: null };

		// Robot's uploaded protocols, projected to what the Start Run panel
		// needs (id, name, type, parameter schema). Empty list if the robot
		// hasn't been hydrated by an /opentrons devices visit yet.
		const robotProtocols = ((robotDoc as any)?.protocols ?? []).map((p: any) => ({
			opentronsProtocolId: p.opentronsProtocolId ?? null,
			protocolName: p.protocolName ?? '',
			protocolType: p.protocolType ?? null,
			analysisStatus: p.analysisStatus ?? null,
			parametersSchema: p.parametersSchema ?? null
		// Only offer wax-filling protocols on the wax stage — a reagent-filling
		// protocol must never be startable here. Empty -> panel shows its
		// no-protocol state (upload a wax-filling protocol on /opentrons).
		})).filter((p: any) => p.opentronsProtocolId && p.protocolType === 'wax-filling');

		// Last known tip state for this robot — derived from the most recent
		// completed wax run. null on first-ever use; protocol falls back to A1.
		// Wax-tube aspiration floor to SHOW on the form (2026-09-24). The parameters
		// step runs before the deck is scanned, so prefer the fixture of the run's
		// deck when known, else any fixture on this robot that carries a floor.
		// Display only: startRun re-resolves by deck and injects the real value.
		let waxFloorMm: number | null = null;
		try {
			let fx: any = null;
			if (run?.deckId) {
				const deckEq = await Equipment.findById(run.deckId).select('deckLoadName').lean() as any;
				if (deckEq?.deckLoadName) fx = await TipCalibratorFixture.findOne({ deckLoadName: deckEq.deckLoadName }).select('minTipClearanceWaxMm').lean();
			}
			if (!fx) fx = await TipCalibratorFixture.findOne({ robotId: String(robotId), minTipClearanceWaxMm: { $ne: null } }).select('minTipClearanceWaxMm').lean();
			const v = Number((fx as any)?.minTipClearanceWaxMm);
			if (Number.isFinite(v) && v > 0) waxFloorMm = v;
		} catch { /* display only */ }

		const lastTipState = (lastTipRun as any)?.pipetteTipState?.after
			? {
				nextTipIndex: (lastTipRun as any).pipetteTipState.after.nextTipIndex ?? null,
				hostname: (lastTipRun as any).pipetteTipState.after.hostname ?? null,
				capturedAt: (lastTipRun as any).pipetteTipState.after.capturedAt
					? new Date((lastTipRun as any).pipetteTipState.after.capturedAt).toISOString()
					: null
			}
			: null;

		// Tube data
		const tube = activeTube as any;
		const tubeData = tube
			? {
				tubeId: String(tube._id),
				initialVolumeUl: tube.initialVolumeUl ?? 0,
				remainingVolumeUl: tube.remainingVolumeUl ?? 0,
				status: tube.status ?? 'active',
				totalCartridgesFilled: tube.totalCartridgesFilled ?? 0,
				totalRunsUsed: tube.totalRunsUsed ?? 0
			}
			: null;

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

		// Backed cartridges (status 'backing'). Backing-oven tracking and the
		// cure-time gate were removed app-wide (2026-09-23, BUCKET-SYSTEM_PLAN v2):
		// no oven grouping, no readiness — every backed cartridge is loadable.
		// Backed carts sit in their production bucket ("Backed, Checked, and Waiting
		// for Oven") until the board's "Move to oven" releases them (they stay at
		// 'backing', loose) or loadDeck draws them out. `backedBuckets` lists the
		// tubs still holding carts so the operator knows which to fetch.
		const [backedTotalCount, backedCycles] = await Promise.all([
			CartridgeRecord.countDocuments({ status: 'backing' }).catch(() => 0),
			BucketCycle.find({ status: 'open', stage: BACKED_STAGE }).select('bucketId cycleNumber quantity stageEnteredAt').sort({ stageEnteredAt: 1 }).lean().catch(() => [] as any[])
		]);
		const backedReadyCount = backedTotalCount;
		const backedOvens: { ovenId: string; ovenName: string; total: number; ready: number }[] = [];
		const backedBuckets = (backedCycles as any[]).map((c: any) => ({
			bucketId: String(c.bucketId), cycleNumber: Number(c.cycleNumber ?? 0), count: Number(c.quantity ?? 0),
			backedAt: c.stageEnteredAt ? new Date(c.stageEnteredAt).toISOString() : null
		}));

		// Wax lot dropdown (WAX-FLOW-3): in-house WaxBatches + purchased
		// PT-CT-114 receiving lots with remaining volume. Few of these ever
		// exist at once, so a dropdown beats a barcode scan.
		const [waxBatchesRaw, waxReceivingRaw] = await Promise.all([
			WaxBatch.find({ remainingVolumeUl: { $gt: 0 } })
				.select('lotNumber lotBarcode remainingVolumeUl initialVolumeUl createdAt')
				.sort({ createdAt: -1 }).lean().catch(() => []),
			ReceivingLot.find({
				'part.partNumber': WAX_TUBE_PART_NUMBER,
				status: { $in: ['accepted', 'in_progress'] },
				quantity: { $gt: 0 }
			}).select('lotId lotNumber quantity consumedUl createdAt').sort({ createdAt: -1 }).lean().catch(() => [])
		]);
		const waxLots = [
			...(waxBatchesRaw as any[]).map((b: any) => ({
				barcode: b.lotBarcode || b.lotNumber,
				label: `${b.lotNumber} (in-house)`,
				remainingVolumeUl: Number(b.remainingVolumeUl ?? 0),
				source: 'wax_batch' as const
			})),
			...(waxReceivingRaw as any[]).map((l: any) => {
				const totalUl = Number(l.quantity ?? 0) * 12000;
				const remaining = Math.max(0, totalUl - Number(l.consumedUl ?? 0));
				return {
					barcode: l.lotId,
					label: `${l.lotNumber || l.lotId} (purchased)`,
					remainingVolumeUl: remaining,
					source: 'receiving_lot' as const
				};
			})
		].filter((l) => l.remainingVolumeUl > 0);

		// Check if robot is blocked by reagent filling
		const robotBlocked = activeReagentRunRaw
			? { process: 'reagent' as const, runId: activeReagentRunRaw._id ? String(activeReagentRunRaw._id) : null }
			: null;

		return {
			robotId,
			robotName,
			loadError: null,
			robotBlocked,
			runState,
			settings: {
				runDurationMin: wax.runDurationMin ?? 45,
				removeDeckWarningMin: wax.removeDeckWarningMin ?? 5,
				coolingWarningMin: wax.coolingWarningMin ?? 7,
				deckLockoutMin: wax.deckLockoutMin ?? 25,
				incubatorTempC: wax.incubatorTempC ?? 37,
				heaterTempC: wax.heaterTempC ?? 65,
				minCoolingBeforeQcMin: wax.minCoolingBeforeQcMin ?? 2,
				waxPerCartridgeUl: wax.waxPerCartridgeUl ?? 19.2,
				waxFillDeadVolumeUl: wax.waxFillDeadVolumeUl ?? 80
			},
			tubeData,
			backedOvens,
			backedReadyCount,
			backedTotalCount,
			backedBuckets,
			backedLabel: BACKED_LABEL,
			waxLots: JSON.parse(JSON.stringify(waxLots)),
			rejectionCodes,
			fridges,
			// --- OT-2 Start Run panel inputs ---
			// The robot's uploaded protocols (with parameter schemas) for the
			// picker. Empty if the robot hasn't been hydrated.
			robotProtocols,
			// The robot's _id so the embedded run controller knows which OT-2
			// to drive (the existing runState only carries the wax run id).
			opentronsRobotId: robotId,
			// Last completed run's post-run tip-tracker snapshot (if any),
			// to seed the "next tip / tips remaining" readout on the panel.
			lastTipState,
			waxFloorMm
		};
	} catch (err) {
		console.error('[WAX-FILLING PAGE] Load error:', err instanceof Error ? err.message : err);
		// Return safe defaults — do NOT throw a 500; let the page display an error message
		return emptyState(robotId, 'Failed to load wax filling data. Please refresh the page.');
	}
}

export type WaxWizardData = Awaited<ReturnType<typeof loadWaxWizard>>;
