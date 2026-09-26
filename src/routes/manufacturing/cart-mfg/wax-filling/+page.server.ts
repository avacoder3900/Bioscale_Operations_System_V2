import { redirect, fail } from '@sveltejs/kit';

import mongoose from 'mongoose';
import {
	connectDB, WaxFillingRun, CartridgeRecord, Consumable, ManufacturingSettings, generateId,
	Equipment, EquipmentLocation, AuditLog, BackingLot, WaxBatch, ReceivingLot,
	OpentronsRobot, ManualCartridgeRemoval, Ot2BridgeCommand, TipCalibratorFixture
} from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import { findBucketLabels } from '$lib/server/services/bucket-service';
import { resolveFridgeId, resolveCoolingTrayId, resolveDeckId } from '$lib/server/services/equipment-resolve';
import { isAdmin } from '$lib/server/permissions';
import { User } from '$lib/server/db';
import { notifyLowWaxBatch, notifyRunLifecycle, shouldWarnLowWax } from '$lib/server/notifications';
import { checkRobotConflict, checkDeckConflict, checkTrayConflict } from '$lib/server/manufacturing/resource-locks';
import { protectLockedCarts, LOCKED_STATUSES } from '$lib/server/manufacturing/locked-cartridges';
import { getRobot, robotGet, bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';
import { bridgeJobGate } from '$lib/server/opentrons/bridge-token';
import { requirePermission } from '$lib/server/permissions';
// OT2-TAILNET-5 §7.1: the run lifecycle's BIMS halves (moved out of this file,
// unchanged) + the prepare/confirm actions the tailnet line calls.
import {
	advanceCartsToWaxFilled,
	startRunQueue,
	recordRunFinishedQueue,
	stopRunQueue,
	reconcileStartIntent,
	setRunRecordStatus,
	lifecycleActions,
	isActionFail
} from '$lib/server/opentrons/run-lifecycle-records';
import bcrypt from 'bcryptjs';
import type { PageServerLoad, Actions } from './$types';

// Legacy fallback for runs created before fillVolumeUl was computed per run
// (WAX-FLOW-3: waxPerCartridgeUl × plannedCartridgeCount + waxFillDeadVolumeUl).
const LEGACY_WAX_FILL_VOLUME_UL = 800;

const WAX_TUBE_PART_NUMBER = 'PT-CT-114'; // purchased 15ml wax tubes (ReceivingLot source)

/** 2ml-tube fill volume for a run (WAX-FLOW-3). */
function computeFillVolumeUl(waxSettings: any, plannedCount: number): number {
	const perCart = Number(waxSettings?.waxPerCartridgeUl ?? 19.2);
	const dead = Number(waxSettings?.waxFillDeadVolumeUl ?? 80);
	return Math.ceil(perCart * Math.max(1, plannedCount) + dead);
}

/**
 * Verify admin credentials for an override. Looks up the user by username,
 * bcrypt-compares the password, and confirms admin permission. Returns the
 * verified user on success or an error string on failure.
 */
async function verifyAdminOverride(username: string, password: string): Promise<
	{ ok: true; user: { _id: string; username: string } } | { ok: false; error: string }
> {
	if (!username || !password) return { ok: false, error: 'Admin username and password are required.' };
	const admin = await User.findOne({ username }).lean() as any;
	if (!admin) return { ok: false, error: 'Invalid admin credentials.' };
	const match = await bcrypt.compare(password, admin.passwordHash ?? '');
	if (!match) return { ok: false, error: 'Invalid admin credentials.' };
	if (!isAdmin(admin)) return { ok: false, error: 'User is not an admin.' };
	return { ok: true, user: { _id: String(admin._id), username: admin.username } };
}

// Extend Vercel serverless timeout to 60s (default is 10s)
export const config = { maxDuration: 60 };

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

const ACTIVE_STAGES = new Set(['Setup', 'Loading', 'Running', 'Awaiting Removal', 'QC', 'Storage',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling', 'qc', 'storage']);

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
			deckId: null, waxSourceLot: null, coolingTrayId: null, plannedCartridgeCount: null,
			opentronsRunId: null as string | null,
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

export const load: PageServerLoad = async ({ locals, url, parent }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'waxFilling:read');

	// Get robotId from URL param or first robot from layout — do this BEFORE connectDB
	// so we have a safe fallback even if DB is unavailable
	let layoutData: Awaited<ReturnType<typeof parent>>;
	try {
		layoutData = await parent();
	} catch (err) {
		console.error('[WAX-FILLING PAGE] parent() error:', err instanceof Error ? err.message : err);
		return emptyState('', 'Layout data unavailable. Please refresh.');
	}

	const robotIdParam = url.searchParams.get('robot');
	const robotId = String(robotIdParam ?? layoutData.robots?.[0]?.robotId ?? '');

	if (!robotId) {
		return emptyState('', 'No robots configured. Add a robot in equipment settings.');
	}

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
			(await import('$lib/server/db')).ReagentBatchRecord.findOne({
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

		// Backed cartridges ("In Oven", status 'backing'). Backing-oven tracking
		// and the cure-time gate were removed app-wide (2026-09-23, BUCKET-SYSTEM_PLAN
		// v2): no oven grouping, no readiness — every backed cartridge is loadable.
		const backedTotalCount = await CartridgeRecord.countDocuments({ status: 'backing' }).catch(() => 0);
		const backedReadyCount = backedTotalCount;
		const backedOvens: { ovenId: string; ovenName: string; total: number; ready: number }[] = [];

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

		const robotName =
			(layoutData.robots as any[] | undefined)?.find((r) => r.robotId === robotId)?.name ??
			'Wax Filling';

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
};

/**
 * Resolve the active wax run for a post-OT-2 action.
 *
 * Once confirmDeckRemoved sets robotReleasedAt, the page's load filter
 * excludes the run, so data.runState.runId becomes null on the client. If
 * the operator then clicks "Confirm — Deck Placed in Oven" in PostRunCooling,
 * the handler would otherwise submit an empty runId. Fall back to looking
 * up the most recent post-OT-2 wax run for this robot using the robotId
 * the client also sends.
 */
const POST_OT2_WAX_STATUSES = ['Awaiting Removal', 'QC', 'Storage'];
async function resolveWaxRunId(data: FormData): Promise<string | null> {
	const runId = (data.get('runId') as string | null)?.trim() ?? '';
	if (runId) return runId;
	const robotId = (data.get('robotId') as string | null)?.trim() ?? '';
	if (!robotId) return null;
	const run = await WaxFillingRun.findOne({
		'robot._id': robotId,
		status: { $in: POST_OT2_WAX_STATUSES },
		robotReleasedAt: { $exists: true }
	}).sort({ createdAt: -1 }).select('_id').lean() as any;
	return run ? String(run._id) : null;
}

// stopRobotRun, advanceCartsToWaxFilled and cartsFilledPerRobotLog moved to
// $lib/server/opentrons/run-lifecycle-records (the stop + well parse are the
// shared 'run.stop' / 'run.commands' verbs and parseFilledWells).

export const actions: Actions = {
	/** Create a new wax filling run — starts directly in Loading (the setup
	 *  confirmation screen was removed in WAX-FLOW-3). */
	createRun: async ({ request, locals, url }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const robotId = (data.get('robotId') as string) ?? url.searchParams.get('robot') ?? '';

		// Cross-process robot conflict check — blocks if ANY wax OR reagent run
		// on this robot is in a page-owned stage. The partial unique index on
		// wax_filling_runs catches within-collection races; this catches the
		// cross-collection case (reagent already on this robot).
		const robotErr = await checkRobotConflict(robotId);
		if (robotErr) return fail(400, { error: robotErr });

		const robotDoc = await Equipment.findOne({ _id: robotId, equipmentType: 'robot' }, { _id: 1, name: 1 }).lean() as any;
		const run = await WaxFillingRun.create({
			robot: { _id: robotId, name: robotDoc?.name ?? robotId },
			operator: { _id: locals.user!._id, username: locals.user!.username },
			status: 'Loading',
			cartridgeIds: [],
			setupTimestamp: new Date()
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: String(run._id),
			action: 'INSERT',
			changedBy: locals.user?.username,
			changedAt: new Date()
		});

		return { success: true, runId: String(run._id) };
	},

	/**
	 * Record wax preparation (WAX-FLOW-3): wax lot chosen from a dropdown,
	 * fill volume computed from cartridge count. Validates the selected lot
	 * still has enough remaining volume server-side.
	 */
	recordWaxPrep: async ({ request, locals, url }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		let runId = data.get('runId') as string;
		const robotId = (data.get('robotId') as string) ?? url.searchParams.get('robot') ?? '';
		const waxSourceLot = (data.get('waxSourceLot') as string)?.trim() || '';
		const plannedCartridgeCount = data.get('plannedCartridgeCount') ? Number(data.get('plannedCartridgeCount')) : 24;

		if (!waxSourceLot) return fail(400, { error: 'Select a wax lot' });
		if (!plannedCartridgeCount || plannedCartridgeCount < 1 || plannedCartridgeCount > 24) {
			return fail(400, { error: 'Cartridge count must be 1-24' });
		}

		// Deferred run creation (WAX-FLOW): selecting a robot no longer creates a
		// run — it's created here on "wax setup complete" so idle robots stay
		// idle. If the caller already has a run (legacy/manual start), reuse it.
		if (!runId) {
			if (!robotId) return fail(400, { error: 'Robot ID required' });
			const robotErr = await checkRobotConflict(robotId);
			if (robotErr) return fail(400, { error: robotErr });
			const robotDoc = await Equipment.findOne({ _id: robotId, equipmentType: 'robot' }, { _id: 1, name: 1 }).lean() as any;
			const newRun = await WaxFillingRun.create({
				robot: { _id: robotId, name: robotDoc?.name ?? robotId },
				operator: { _id: locals.user!._id, username: locals.user!.username },
				status: 'Loading',
				cartridgeIds: [],
				setupTimestamp: new Date()
			});
			await AuditLog.create({
				_id: generateId(),
				tableName: 'wax_filling_runs',
				recordId: String(newRun._id),
				action: 'INSERT',
				changedBy: locals.user?.username,
				changedAt: new Date()
			});
			runId = String(newRun._id);
		}

		const settingsDoc = await ManufacturingSettings.findById('default').select('waxFilling').lean() as any;
		const fillVolumeUl = computeFillVolumeUl(settingsDoc?.waxFilling, plannedCartridgeCount);

		// Validate remaining volume on whichever source the dropdown row came from
		const [waxBatch, waxReceiving] = await Promise.all([
			WaxBatch.findOne({ $or: [{ lotBarcode: waxSourceLot }, { lotNumber: waxSourceLot }] })
				.select('remainingVolumeUl lotNumber').lean() as any,
			ReceivingLot.findOne({
				$or: [{ lotId: waxSourceLot }, { bagBarcode: waxSourceLot }, { lotNumber: waxSourceLot }],
				'part.partNumber': WAX_TUBE_PART_NUMBER
			}).select('quantity consumedUl lotNumber lotId').lean() as any
		]);
		let remaining: number | null = null;
		if (waxBatch) {
			remaining = Number(waxBatch.remainingVolumeUl ?? 0);
		} else if (waxReceiving) {
			remaining = Math.max(0, Number(waxReceiving.quantity ?? 0) * 12000 - Number(waxReceiving.consumedUl ?? 0));
		}
		if (remaining === null) return fail(404, { error: `Wax lot "${waxSourceLot}" not found` });
		if (remaining < fillVolumeUl) {
			return fail(400, { error: `Wax lot only has ${remaining} μL remaining — this run needs ${fillVolumeUl} μL. Pick another lot.` });
		}

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'Loading', waxSourceLot, plannedCartridgeCount, fillVolumeUl }
		});
		return { success: true, fillVolumeUl };
	},

	/** Load deck — add cartridges to run */
	loadDeck: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const deckIdRaw = (data.get('deckId') as string) || undefined;
		// S2c: resolve deck reference to canonical Equipment._id at entry; all
		// downstream writes (waxFilling.deckId on cartridges, WaxFillingRun.deckId)
		// use the resolved value.
		const deckId = deckIdRaw ? ((await resolveDeckId(deckIdRaw)) ?? deckIdRaw) : undefined;
		const ovenId = (data.get('ovenId') as string) || undefined;
		const cartridgeScansRaw = data.get('cartridgeScans') as string;
		// WAX-FLOW-2: per-cartridge oven-time admin override + test mode
		const override = data.get('override') === 'true';
		const testMode = data.get('testMode') === 'true';
		const adminUser = (data.get('adminUser') as string)?.trim() ?? '';
		const adminPass = (data.get('adminPass') as string) ?? '';

		// Deck conflict check runs at scan time (see /api/dev/validate-equipment
		// ?type=deck). No duplicate check here — this action is the commit.

		let cartridgeIds: string[] = [];
		if (cartridgeScansRaw) {
			try {
				const parsed = JSON.parse(cartridgeScansRaw);
				// Handle both [{cartridgeId, backedLotId}] and ["id1","id2"] formats
				cartridgeIds = parsed.map((item: any) =>
					typeof item === 'string' ? item : item.cartridgeId
				);
			} catch {
				return fail(400, { error: 'Invalid cartridge scan data' });
			}
		}

		// Hard cap at 24 cartridges per deck load
		if (cartridgeIds.length > 24) {
			return fail(400, { error: `Maximum 24 cartridges per deck. Received ${cartridgeIds.length}.` });
		}

		// Check for duplicate barcodes in this scan batch
		const uniqueIds = new Set(cartridgeIds);
		if (uniqueIds.size !== cartridgeIds.length) {
			const dupes = cartridgeIds.filter((id, i) => cartridgeIds.indexOf(id) !== i);
			return fail(400, { error: `Duplicate barcode(s) scanned: ${[...new Set(dupes)].join(', ')}` });
		}

		// Check if any of these cartridges are already in another active wax run.
		// Excludes cartridges whose waxFilling.runId is *this* run so a retry of a
		// half-completed loadDeck (cartridges written, run update missed) doesn't
		// dead-end the operator with "already processed" — the second submission
		// is idempotent for the same runId.
		if (cartridgeIds.length > 0) {
			const alreadyInUse = await CartridgeRecord.find({
				_id: { $in: cartridgeIds },
				'waxFilling.runId': { $exists: true, $ne: runId },
				status: { $nin: [null, 'backing', 'voided'] }
			}).select('_id status waxFilling.runId').lean();

			if (alreadyInUse.length > 0) {
				const ids = (alreadyInUse as any[]).map((c: any) => c._id).join(', ');
				return fail(400, { error: `Cartridge(s) already processed: ${ids}. These have already been through wax filling.` });
			}
		}

		// Validate deck if provided
		if (deckId) {
			const deck = await Equipment.findOne({ _id: deckId, equipmentType: 'deck' }).lean();
			if (!deck) return fail(400, { error: `Deck '${deckId}' not found. Register it in Equipment first.` });
			if ((deck as any).status === 'retired') return fail(400, { error: `Deck '${deckId}' is retired.` });
		}

		// Validate oven if provided
		if (ovenId) {
			const oven = await Equipment.findOne({
				$or: [{ _id: ovenId }, { barcode: ovenId }],
				equipmentType: 'oven'
			}).lean();
			if (!oven) return fail(400, { error: `Oven '${ovenId}' not found. Register it in Equipment first.` });
			if ((oven as any).status === 'retired' || (oven as any).status === 'offline') {
				return fail(400, { error: `Oven '${ovenId}' is ${(oven as any).status}.` });
			}
		}

		const run = await WaxFillingRun.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });

		// Cartridges arrive here at status 'backing' ("In Oven"), drawn out of a
		// pressed production bucket at WI-01. loadDeck validates each scan against
		// those records. Backing-oven tracking and the cure-time gate were removed
		// app-wide (2026-09-23) — nothing here reads oven entry time any more.
		if (cartridgeIds.length > 0) {
			const now = new Date();

			const existingCarts = await CartridgeRecord.find(
				{ _id: { $in: cartridgeIds } },
				{ _id: 1, status: 1, 'waxFilling.runId': 1 }
			).lean() as any[];
			const cartById = new Map(existingCarts.map((c: any) => [String(c._id), c]));

			const missing: string[] = [];
			const wrongStatus: { id: string; status: string }[] = [];
			for (const cid of cartridgeIds) {
				const c = cartById.get(cid);
				if (!c) { missing.push(cid); continue; }
				// Idempotent retry: already stamped onto this run by a prior submit
				if (c.status === 'wax_filling' && c.waxFilling?.runId === runId) continue;
				if (c.status !== 'backing') { wrongStatus.push({ id: cid, status: c.status ?? '(none)' }); continue; }
			}

			// Test mode: synthesize backed carts for unknown barcodes so the
			// flow can be exercised end-to-end without WI-01. Synthetic carts
			// have no backing.parentLotRecordId — cancel/abort deletes them.
			if (missing.length > 0 && testMode) {
				// Never synthesize a cartridge from a production bucket's label —
				// a tub wearing a UUID QR sticker scans exactly like a cartridge
				// (BUCKET-SYSTEM_PLAN §9.4).
				const bucketLabels = await findBucketLabels(missing);
				if (bucketLabels.size > 0) {
					const details = [...bucketLabels].map(([code, b]) => `${code} is the label on bucket ${b}`).join('; ');
					return fail(400, { error: `Not cartridges — ${details}. Remove them from the deck scan.` });
				}
				await CartridgeRecord.bulkWrite(missing.map((cid) => ({
					updateOne: {
						filter: { _id: cid },
						update: {
							$setOnInsert: {
								_id: cid,
								status: 'backing',
								'backing.operator': { _id: locals.user!._id, username: locals.user!.username },
								'backing.recordedAt': now
							}
						},
						upsert: true
					}
				})));
				await AuditLog.create({
					_id: generateId(),
					tableName: 'cartridge_records',
					recordId: runId,
					action: 'INSERT',
					changedBy: locals.user.username,
					changedAt: now,
					reason: 'Test mode — synthetic backed cartridges for end-to-end test',
					newData: { testMode: true, runId, cartridgeIds: missing }
				});
				missing.length = 0;
			}

			if (missing.length > 0) {
				return fail(400, { error: `Cartridge(s) not found in backing: ${missing.join(', ')}. Draw them into the oven at Cartridge Back (WI-01) first.` });
			}
			if (wrongStatus.length > 0) {
				return fail(400, { error: `Cartridge(s) not available for wax filling: ${wrongStatus.map((w) => `${w.id} (${w.status})`).join(', ')}.` });
			}

			const ops = cartridgeIds.map((cid: string, idx: number) => ({
				updateOne: {
					filter: { _id: cid },
					update: {
						$set: {
							status: 'wax_filling',
							'waxFilling.runId': runId,
							'waxFilling.deckId': deckId ?? null,
							'waxFilling.robotId': run.robot?._id ?? null,
							'waxFilling.robotName': run.robot?.name ?? null,
							'waxFilling.deckPosition': idx + 1,
							'waxFilling.operator': { _id: locals.user!._id, username: locals.user!.username }
						}
					}
				}
			}));
			try {
				await CartridgeRecord.bulkWrite(ops);
			} catch (err) {
				console.error('[loadDeck] bulkWrite error:', err instanceof Error ? err.message : err);
				return fail(500, { error: `Failed to save cartridge records: ${err instanceof Error ? err.message : 'Unknown error'}` });
			}
		}

		// The cartridge bulkWrite above stamps each cart with waxFilling.runId,
		// but the run itself doesn't know about them until this $addToSet lands.
		// If this update silently fails (driver timeout, etc.), the cartridges
		// are marooned: status=wax_filling pointing at a run with empty
		// cartridgeIds — invisible in every wax-filling UI. Surface that
		// failure loudly so the operator can retry (which is now safe due to
		// the alreadyInUse same-run exclusion above).
		try {
			const updatedRun = await WaxFillingRun.findByIdAndUpdate(runId, {
				$set: {
					status: 'Loading',
					deckId: deckId ?? run.deckId,
					ovenId: ovenId ?? run.ovenId,
					plannedCartridgeCount: cartridgeIds.length || run.plannedCartridgeCount
				},
				$addToSet: { cartridgeIds: { $each: cartridgeIds } }
			}, { new: true });
			if (!updatedRun) {
				console.error(`[loadDeck] WaxFillingRun ${runId} update returned null — run not found`);
				return fail(500, { error: `Run ${runId} could not be updated (not found). Cartridges were saved — click Confirm Load again to retry.` });
			}
		} catch (err) {
			console.error('[loadDeck] WaxFillingRun update failed:', err instanceof Error ? err.message : err);
			return fail(500, { error: `Failed to attach cartridges to run: ${err instanceof Error ? err.message : 'Unknown error'}. Cartridges were saved — click Confirm Load again to retry.` });
		}

		return { success: true };
	},

	/**
	 * Start the robot run.
	 *
	 * Three-step handshake with the OT-2:
	 *   1. Read the operator's chosen parameters from the form, coerce each
	 *      value back to its native type using the protocol's parameter schema.
	 *   2. POST /runs on the robot to create the run with runTimeParameterValues.
	 *   3. POST /runs/<rid>/actions {actionType:'play'} to start execution.
	 *
	 * Then stamp the WaxFillingRun with what we asked for + linkage:
	 *   - protocolParameters: the exact values used (Mixed)
	 *   - opentronsRunId: the robot's run UUID (for monitoring + autoadvance)
	 *   - pipetteTipState.before: carried over from the previous run's `after`
	 *
	 * Status transitions setup→Running atomically with the OT-2 work — if
	 * the robot rejects the run, the wax run stays in its prior stage.
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
		const r = await startRunQueue('wax', data, { _id: locals.user._id, username: locals.user.username });
		if (isActionFail(r)) return fail(r.fail.status, { error: r.fail.error });
		return r;
	},

	/**
	 * Record the OT-2 run as finished (called by the client when the embedded
	 * controller observes status → succeeded / stopped / failed).
	 *
	 * Pulls the run's commands list from the robot, scans the protocol's
	 * `TIP TRACKER` comments to find the last reported next-tip index, and
	 * stamps pipetteTipState.after on the WaxFillingRun along with consumed
	 * count. Wax-filling status itself is unchanged — the operator still
	 * has to physically remove the deck and click "Deck Removed".
	 */
	recordRunFinished: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const finalStatus = (data.get('finalStatus')?.toString() ?? '').toLowerCase();
		const r = await recordRunFinishedQueue('wax', runId, finalStatus, { _id: locals.user._id, username: locals.user.username });
		if (isActionFail(r)) return fail(r.fail.status, { error: r.fail.error });
		return r;
	},

	/**
	 * Confirm deck removed + store in one commit (WAX-SIMPLIFY-1: deck-removed →
	 * fridge → wax_filled). Replaces the old cooling → completeQC → recordStorage →
	 * completeRun chain. The operator clicks "Confirm — Deck Removed", picks the
	 * fridge the deck is stored in, and every cartridge on the run goes straight
	 * wax_filling → wax_filled — wax_filled IS the stored state; the fridge is a
	 * location (waxStorage), not a status. Visual QC happens by eye on wax_filled
	 * carts; rejects go through the Wax Reject page. Preserves the two
	 * non-redundant side effects from the old chain: the waxFilling phase
	 * WRITE-ONCE record (DHR / traceability) and the per-cartridge wax consumption
	 * (PT-CT-105).
	 */
	storeDeckAndComplete: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = (data.get('runId') as string)?.trim();
		const storageLocation = (data.get('storageLocation') as string)?.trim();
		if (!runId) return fail(400, { error: 'Missing runId' });
		if (!storageLocation) return fail(400, { error: 'Pick a fridge to store the deck in' });

		const run = await WaxFillingRun.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });
		// Idempotent: a second click after success is a no-op.
		if (run.status === 'completed') return { success: true };

		const now = new Date();
		// S1a: resolve the scanned/selected fridge reference to Equipment._id.
		const resolvedLocationId = await resolveFridgeId(storageLocation);

		if (run.cartridgeIds?.length) {
			// Locked carts (linked/underway/completed/voided/scrapped) skipped + audited.
			const { safeIds } = await protectLockedCarts(
				run.cartridgeIds,
				'storeDeckAndComplete',
				runId,
				{ _id: locals.user!._id, username: locals.user!.username }
			);

			if (safeIds.length > 0) {
				// One write per cart: stamp the waxFilling phase record + storage
				// location and flip straight to wax_filled. Filter on status so we
				// only touch this run's carts that are actually still wax_filling.
				const bulkOps = safeIds.map((cid: string) => ({
					updateOne: {
						filter: { _id: cid, status: 'wax_filling' },
						update: {
							$set: {
								'waxFilling.runId': run._id,
								'waxFilling.robotId': run.robot?._id,
								'waxFilling.robotName': run.robot?.name,
								'waxFilling.deckId': run.deckId,
								'waxFilling.waxTubeId': run.waxTubeId,
								'waxFilling.waxSourceLot': run.waxSourceLot,
								'waxFilling.operator': run.operator,
								'waxFilling.runStartTime': run.runStartTime,
								'waxFilling.runEndTime': now,
								'waxFilling.recordedAt': now,
								'waxStorage.locationId': resolvedLocationId,
								'waxStorage.location': storageLocation,
								'waxStorage.operator': { _id: locals.user!._id, username: locals.user!.username },
								'waxStorage.timestamp': now,
								'waxStorage.recordedAt': now,
								status: 'wax_filled'
							}
						}
					}
				}));
				await CartridgeRecord.bulkWrite(bulkOps);

				// Consume wax (PT-CT-105) per cartridge — same as the old completeQC.
				try {
					const waxPartId = await resolvePartId('PT-CT-105');
					for (const cid of safeIds) {
						await recordTransaction({
							transactionType: 'consumption',
							partDefinitionId: waxPartId ?? undefined,
							cartridgeRecordId: cid,
							lotId: run.waxSourceLot ?? undefined,
							quantity: 1,
							manufacturingStep: 'wax_filling',
							manufacturingRunId: String(run._id),
							operatorId: run.operator?._id,
							operatorUsername: run.operator?.username,
							notes: `Wax-filled cartridge stored (deck-removed commit) in run ${run._id}, fridge ${storageLocation}`
						});
					}
				} catch (e) {
					console.error('[storeDeckAndComplete] consumption recordTransaction failed:', e instanceof Error ? e.message : e);
				}
			}
		}

		// Complete the run — robot freed, deck off. status='completed' is not
		// page-owned, so the load drops it and the page resets to "Start new run".
		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'completed', deckRemovedTime: now, robotReleasedAt: now, runEndTime: now }
		});

		try {
			await AuditLog.create({
				_id: generateId(),
				tableName: 'wax_filling_runs',
				recordId: runId,
				action: 'UPDATE',
				changedBy: locals.user?.username,
				changedAt: now,
				newData: { status: 'completed', cartridgeStatus: 'wax_filled', storageLocation }
			});
		} catch (e) {
			console.error('[storeDeckAndComplete] audit log failed:', e instanceof Error ? e.message : e);
		}

		return { success: true };
	},

	/** Reset run back to Loading stage (deck loading) — clears deckId and cartridges so operator can re-scan */
	resetToLoading: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		if (!runId) return fail(400, { error: 'Missing runId' });

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'Loading' },
			$unset: { deckId: '', runStartTime: '', runEndTime: '', deckRemovedTime: '', coolingTrayId: '', coolingConfirmedTime: '' }
		});

		return { success: true };
	},

	/**
	 * Close out a BackingLot bucket with leftover cartridgeCount.
	 *
	 * loadDeck only flips status='consumed' when cartridgeCount drains to 0,
	 * so partial buckets that the operator doesn't fully use stay 'ready'
	 * forever and inflate Backing tile counts on the cart-mfg dashboard.
	 * This action mirrors scrap/removeFromBackingLot but always closes the
	 * full remainder in one shot.
	 */
	closeBucket: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = ((data.get('lotId') as string) ?? '').trim();
		const reason = ((data.get('reason') as string) ?? '').trim();
		if (!lotId) return fail(400, { error: 'Missing lotId' });
		if (!reason) return fail(400, { error: 'Reason is required' });

		const lot = await BackingLot.findById(lotId).select('cartridgeCount status').lean() as any;
		if (!lot) return fail(404, { error: `Backing lot "${lotId}" not found` });
		if (lot.status === 'consumed') {
			return fail(400, { error: `Lot ${lotId} is already consumed` });
		}

		// Refuse if any cart from this lot is still mid-backing (shouldn't
		// happen — wax-fill stamps status='wax_filling' on every cart it
		// pulls — but a stranded 'backing' record would indicate a real
		// bucket in the oven that this action shouldn't quietly wipe).
		const stillBacking = await CartridgeRecord.countDocuments({
			'backing.lotId': lotId,
			status: 'backing'
		});
		if (stillBacking > 0) {
			return fail(409, {
				error: `${stillBacking} cartridge(s) from lot ${lotId} are still in status='backing'. Resolve those first.`
			});
		}

		const remainder = lot.cartridgeCount ?? 0;
		const now = new Date();

		await BackingLot.findByIdAndUpdate(lotId, {
			$set: { cartridgeCount: 0, status: 'consumed' }
		});

		const removalId = generateId();
		if (remainder > 0) {
			await ManualCartridgeRemoval.create({
				_id: removalId,
				cartridgeIds: [],
				cartridgeCount: remainder,
				backingLotId: lotId,
				reason,
				operator: { _id: locals.user._id, username: locals.user.username },
				removedAt: now
			});
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'backing_lots',
			recordId: lotId,
			action: 'CLOSE_BUCKET',
			changedBy: locals.user.username,
			changedAt: now,
			oldData: { cartridgeCount: remainder, status: lot.status },
			newData: { cartridgeCount: 0, status: 'consumed', removalGroupId: remainder > 0 ? removalId : null, reason }
		});

		return { closeBucket: { success: true, lotId, remainder } };
	},

	/** Cancel / abort an active run — only available before the OT-2 finishes */
	cancelRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const reason = (data.get('reason') as string) || 'Cancelled by operator';
		// Halts the OT-2 first ('run.stop'), reads which carts it finished (smart
		// abort), then records — see stopConfirm in run-lifecycle-records.
		const r = await stopRunQueue('wax', 'cancel', runId, { reason }, { _id: locals.user._id, username: locals.user.username });
		if (isActionFail(r)) return fail(r.fail.status, { error: r.fail.error });
		return r;
	},

	abortRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const reason = (data.get('reason') as string) || 'Aborted';
		const r = await stopRunQueue('wax', 'abort', runId, { reason }, { _id: locals.user._id, username: locals.user.username });
		if (isActionFail(r)) return fail(r.fail.status, { error: r.fail.error });
		return r;
	},

	// OT2-TAILNET-5 two-phase lifecycle (tailnet line): startPrepare, startBundle,
	// startRecordResync, startConfirm, finishConfirm, cancelConfirm, abortConfirm.
	...lifecycleActions('wax'),

	/**
	 * Save an operator-entered note against the wax run. Append-only metadata —
	 * does NOT mutate run status, cartridge status, or any lifecycle field. The
	 * note is mirrored to every cartridge currently on the run (phase='wax_run')
	 * AND to WaxFillingRun.notes[] so run-history surfaces can read run.notes
	 * directly. At most one wax_run note per cartridge — re-saving overwrites.
	 */
	/**
	 * Mid-run tip swap (2026-08-18). Asks the on-robot bridge daemon to write a
	 * request file that the running wax protocol polls before every dispense.
	 * The protocol then empties the tip, swaps it (mode 'rack' = robot takes the
	 * next tracked tip; 'hand' = pauses for the operator to push one on),
	 * re-probes it on the calibrator, and re-aspirates + continues at the very
	 * well it was about to fill. Works whether the run is running or paused.
	 */
	requestTipSwap: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const data = await request.formData();
		const runId = data.get('runId')?.toString();
		const mode = data.get('mode')?.toString() === 'hand' ? 'hand' : 'rack';
		const cancel = data.get('cancel')?.toString() === 'true';
		if (!runId) return fail(400, { error: 'Missing runId' });
		const run = await WaxFillingRun.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });
		const robotId = run.robot?._id;
		const robot = robotId ? await OpentronsRobot.findById(robotId).lean() as any : null;
		if (!robot) return fail(400, { error: 'Run has no OT-2 robot' });
		if (data.get('line')?.toString() === 'tailnet') {
			// OT2-TAILNET-5 S6: the tailnet prepare. Same guards and the same
			// AuditLog row (stamped line + bridgeJobId), but NO Ot2BridgeCommand —
			// the browser submits the returned job to the robot daemon's /bridge.
			// {phase:'abandon'} records that the browser's submit failed.
			requirePermission(locals.user, 'manufacturing:write');
			const now = new Date();
			if (data.get('phase')?.toString() === 'abandon') {
				const bridgeJobId = data.get('bridgeJobId')?.toString() ?? '';
				if (!/^[A-Za-z0-9_-]{6,64}$/.test(bridgeJobId)) return fail(400, { error: 'bridgeJobId is required' });
				await AuditLog.create({
					_id: generateId(),
					tableName: 'wax_filling_runs',
					recordId: runId,
					action: 'wax_tip_swap_submit_failed',
					changedBy: locals.user.username,
					changedAt: now,
					newData: {
						opentronsRunId: run.opentronsRunId ?? null,
						robotId: String(robotId),
						line: 'tailnet',
						bridgeJobId,
						error: (data.get('error')?.toString() ?? '').slice(0, 500) || 'bridge submit failed'
					}
				});
				return { success: true, abandoned: true };
			}
			const gate = bridgeJobGate(robot);
			if (!gate.ok) return fail(409, { error: gate.reason });
			const bridgeJobId = generateId();
			await AuditLog.create({
				_id: generateId(),
				tableName: 'wax_filling_runs',
				recordId: runId,
				action: cancel ? 'wax_tip_swap_cancel' : 'wax_tip_swap_request',
				changedBy: locals.user.username,
				changedAt: now,
				newData: { mode, cancel, opentronsRunId: run.opentronsRunId ?? null, robotId: String(robotId), line: 'tailnet', bridgeJobId }
			});
			return {
				success: true,
				tipSwap: cancel ? 'cancelled' : mode,
				line: 'tailnet',
				job: {
					jobId: bridgeJobId,
					kind: 'tip_swap_request',
					payload: { mode, cancel, runId: run.opentronsRunId ?? null, requestedBy: locals.user.username }
				}
			};
		}
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
		// AuditLog's schema is tableName/recordId/changedBy/changedAt/newData — the
		// previous shape (resourceType/username/details) was silently dropped by
		// Mongoose, leaving rows with only an action and a time (found 2026-09-17).
		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: runId,
			action: cancel ? 'wax_tip_swap_cancel' : 'wax_tip_swap_request',
			changedBy: locals.user.username,
			changedAt: new Date(),
			newData: { mode, cancel, opentronsRunId: run.opentronsRunId ?? null, robotId: String(robotId) }
		});
		return { success: true, tipSwap: cancel ? 'cancelled' : mode };
	},

	recordWaxRunNote: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const noteBody = ((data.get('noteBody') as string) ?? '').trim();

		if (!runId) return fail(400, { error: 'runId is required' });
		if (!noteBody) return fail(400, { error: 'Note body is empty' });

		const run = await WaxFillingRun.findById(runId).select('cartridgeIds').lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });

		const cartridgeIds: string[] = (run.cartridgeIds ?? []).filter(Boolean);

		const now = new Date();
		const noteId = generateId();
		const noteEntry = {
			_id: noteId,
			body: noteBody,
			phase: 'wax_run',
			author: { _id: locals.user!._id, username: locals.user!.username },
			createdAt: now
		};

		// Pull then push: a single wax_run note exists per cartridge AND on the
		// run document. Re-saves overwrite — operator can refine the note up
		// until they click Complete Run.
		const cartridgeOps = cartridgeIds.length > 0 ? [
			CartridgeRecord.updateMany(
				{ _id: { $in: cartridgeIds } },
				{ $pull: { notes: { phase: 'wax_run' } } }
			),
			CartridgeRecord.updateMany(
				{ _id: { $in: cartridgeIds } },
				{ $push: { notes: noteEntry } }
			)
		] : [];

		await Promise.all([
			WaxFillingRun.updateOne({ _id: runId }, { $pull: { notes: { phase: 'wax_run' } } }),
			...cartridgeOps.slice(0, 1)
		]);
		await Promise.all([
			WaxFillingRun.updateOne({ _id: runId }, { $push: { notes: noteEntry } }),
			...cartridgeOps.slice(1)
		]);

		return { success: true, noteId, cartridgeCount: cartridgeIds.length };
	},

};
