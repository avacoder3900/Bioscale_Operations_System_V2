import { redirect, fail } from '@sveltejs/kit';
import { isCureComplete } from '$lib/server/manufacturing/cure-time';
import mongoose from 'mongoose';
import {
	connectDB, WaxFillingRun, CartridgeRecord, Consumable, ManufacturingSettings, generateId,
	Equipment, EquipmentLocation, AuditLog, BackingLot, WaxBatch, ReceivingLot,
	OpentronsRobot, ManualCartridgeRemoval, Ot2BridgeCommand
} from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import { resolveFridgeId, resolveCoolingTrayId, resolveDeckId } from '$lib/server/services/equipment-resolve';
import { isAdmin } from '$lib/server/permissions';
import { User } from '$lib/server/db';
import { notifyLowWaxBatch, notifyRunLifecycle, shouldWarnLowWax } from '$lib/server/notifications';
import { checkRobotConflict, checkDeckConflict, checkTrayConflict } from '$lib/server/manufacturing/resource-locks';
import { protectLockedCarts, LOCKED_STATUSES } from '$lib/server/manufacturing/locked-cartridges';
import { getRobot, robotGet, robotPost, bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';
import { calibrationRtpValues } from '$lib/server/opentrons/calibration-rtps';
import { ensureFreshRunProtocol } from '$lib/server/opentrons/protocol-freshness';
import { resolveDeckBinding, DeckBindingError } from '$lib/server/services/deck-calibration/run-guard';
import { isHardenedRobot } from '$lib/server/services/deck-calibration/rollout';
import { OpentronsRunRecord } from '$lib/server/db';
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
			protocolParameters: null as Record<string, unknown> | null
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
		}
	};
}

export const load: PageServerLoad = async ({ locals, url, parent }) => {
	if (!locals.user) redirect(302, '/login');

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
				protocolParameters: run.protocolParameters ?? null
			}
			: { hasActiveRun: false, runId: null, stage: null, runStartTime: null, runEndTime: null, deckRemovedTime: null, deckId: null, waxSourceLot: null, coolingTrayId: null, plannedCartridgeCount: null, coolingConfirmedAt: null, existingWaxRunNote: '', opentronsRunId: null, opentronsRunFinalStatus: null, protocolParameters: null };

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

		// Backed cartridges in ovens (per-cartridge, WAX-FLOW-2 — replaces the
		// retired BackingLot aggregate). Grouped by oven for the deck-load hint.
		const minOvenTimeMin = wax.minOvenTimeMin ?? 60;
		const now = Date.now();
		const backedCartsRaw = await CartridgeRecord.find(
			{ status: 'backing' },
			{ _id: 1, 'backing.ovenEntryTime': 1, 'backing.ovenLocationId': 1, 'backing.ovenLocationName': 1 }
		).lean().catch(() => []);

		const ovenGroupMap = new Map<string, { ovenId: string; ovenName: string; total: number; ready: number }>();
		let backedReadyCount = 0;
		for (const c of backedCartsRaw as any[]) {
			const entry = c.backing?.ovenEntryTime ? new Date(c.backing.ovenEntryTime).getTime() : 0;
			const isReady = isCureComplete(c.backing?.ovenEntryTime, minOvenTimeMin, now);
			if (isReady) backedReadyCount++;
			const key = c.backing?.ovenLocationId ?? 'unknown';
			const g = ovenGroupMap.get(key) ?? {
				ovenId: key,
				ovenName: c.backing?.ovenLocationName ?? 'Unknown oven',
				total: 0,
				ready: 0
			};
			g.total++;
			if (isReady) g.ready++;
			ovenGroupMap.set(key, g);
		}
		const backedOvens = [...ovenGroupMap.values()].sort((a, b) => a.ovenName.localeCompare(b.ovenName));

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
			backedTotalCount: (backedCartsRaw as any[]).length,
			waxLots: JSON.parse(JSON.stringify(waxLots)),
			rejectionCodes,
			fridges,
			minOvenTimeMin,
			// --- OT-2 Start Run panel inputs ---
			// The robot's uploaded protocols (with parameter schemas) for the
			// picker. Empty if the robot hasn't been hydrated.
			robotProtocols,
			// The robot's _id so the embedded run controller knows which OT-2
			// to drive (the existing runState only carries the wax run id).
			opentronsRobotId: robotId,
			// Last completed run's post-run tip-tracker snapshot (if any),
			// to seed the "next tip / tips remaining" readout on the panel.
			lastTipState
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

/**
 * Best-effort stop of the OT-2 run backing a wax run, BEFORE we mark the run
 * aborted in BIMS. Without this, abort/cancel only updated the database — the
 * UI exited but the physical robot kept executing the protocol, leaving an
 * un-stoppable "running" run on the device.
 *
 * Resilient by design: a run that never reached the robot, an already-terminal
 * run (404/409/"not found"), or an unreachable robot must NOT block the
 * operator's abort. Returns a human warning string when the stop couldn't be
 * confirmed (so the UI can tell the operator to check the device), else null.
 *
 * `run` must have been selected with `opentronsRunId` and `robot`.
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
		// Already finished/cleared → nothing to stop, treat as success.
		if (res.status === 404 || res.status === 409 || /not found|not allowed|terminal/i.test(String(detail))) {
			return null;
		}
		return `Couldn't stop the run on the robot (${detail}) — confirm on the device.`;
	} catch (e) {
		return `Couldn't reach the robot to stop the run (${e instanceof Error ? e.message : 'unknown'}) — confirm on the device.`;
	}
}


/**
 * Flip a run's carts wax_filling → wax_filled with the full waxFilling phase
 * stamp + PT-CT-105 consumption. Shared by: auto-advance on a clean run
 * completion, the smart abort (advance only the carts the robot actually
 * finished), and the legacy storeDeckAndComplete action.
 * Returns { advanced, skipped } — skipped = locked carts or carts whose status
 * was no longer wax_filling.
 */
async function advanceCartsToWaxFilled(
	run: any,
	cartIds: string[],
	user: { _id: string; username: string },
	via: string
): Promise<{ advanced: number; skipped: number }> {
	if (!cartIds?.length) return { advanced: 0, skipped: 0 };
	const now = new Date();
	const { safeIds } = await protectLockedCarts(cartIds, via, String(run._id), user);
	let advanced = 0;
	if (safeIds.length > 0) {
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
						status: 'wax_filled'
					}
				}
			}
		}));
		const res = await CartridgeRecord.bulkWrite(bulkOps);
		advanced = res.modifiedCount ?? 0;
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
					notes: `Wax-filled cartridge (${via}) in run ${run._id}`
				});
			}
		} catch (e) {
			console.error(`[${via}] consumption recordTransaction failed:`, e instanceof Error ? e.message : e);
		}
	}
	const skipped = cartIds.length - advanced;
	try {
		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: String(run._id),
			action: 'UPDATE',
			changedBy: user.username,
			changedAt: now,
			newData: { via, cartridgeStatus: 'wax_filled', advanced, skipped, cartIds }
		});
	} catch { /* non-fatal */ }
	return { advanced, skipped };
}

/**
 * Which of the run's carts did the robot actually FINISH filling? Parsed from
 * the run's own command log ("Dispensed …uL into well X2" comments). A cart
 * counts as filled only when every well its row-pattern selection expects got a
 * dispense — partially-filled carts are NOT counted (they go back to backing on
 * an abort; scrap-or-keep is the operator's call at QC).
 * cartridgeIds[i] is deck position i+1 (the scan stores slot order).
 */
async function cartsFilledPerRobotLog(robot: any, opentronsRunId: string, run: any): Promise<Set<number>> {
	const filled = new Set<number>();
	const wellsPerCart = new Map<number, Set<string>>();
	let cursor = 0;
	for (let page = 0; page < 5; page++) {
		const res = await robotGet(robot, `/runs/${opentronsRunId}/commands?cursor=${cursor}&pageLength=999`);
		if (!res.ok) break;
		const body = await res.json();
		const cmds = (body.data ?? []) as Array<{ commandType: string; params?: { message?: string } }>;
		for (const c of cmds) {
			if (c.commandType !== 'comment') continue;
			const m = c.params?.message?.match(/Dispensed [\d.]+uL into well ([A-X])(\d+)/);
			if (!m) continue;
			const row = m[1];
			const col = parseInt(m[2], 10);
			// carrier from column (wax = even cols 2-24), cart row-band from letter.
			const carrier = Math.floor((col - 1) / 8); // 0,1,2
			const band = Math.floor('XWVUTSRQPONMLKJIHGFEDCBA'.indexOf(row) / 3); // 0..7 (X,W,V=0 … C,B,A=7)
			const cart = carrier * 8 + band + 1; // 1..24
			if (!wellsPerCart.has(cart)) wellsPerCart.set(cart, new Set());
			wellsPerCart.get(cart)!.add(row + col);
		}
		const total = body?.meta?.totalLength ?? 0;
		cursor += cmds.length;
		if (cursor >= total || cmds.length === 0) break;
	}
	// Expected wells per cart: 4 wax columns × the active row patterns (default 3).
	const pp = run.protocolParameters ?? {};
	const patterns = ['row_pattern_0', 'row_pattern_1', 'row_pattern_2']
		.filter((k) => pp[k] !== false).length || 3;
	const expected = 4 * patterns;
	for (const [cart, wells] of wellsPerCart) {
		if (wells.size >= expected) filled.add(cart);
	}
	return filled;
}

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

		// WAX-FLOW-2: cartridges were already originated at WI-01 backing
		// (status 'backing', full lineage + oven entry time on the record).
		// loadDeck validates each scan against those records and gates on the
		// per-cartridge minimum oven time.
		if (cartridgeIds.length > 0) {
			const now = new Date();
			const settingsDocLd = await ManufacturingSettings.findById('default')
				.select('waxFilling.minOvenTimeMin').lean() as any;
			const minOvenTimeMin: number = settingsDocLd?.waxFilling?.minOvenTimeMin ?? 60;

			const existingCarts = await CartridgeRecord.find(
				{ _id: { $in: cartridgeIds } },
				{ _id: 1, status: 1, 'backing.ovenEntryTime': 1, 'waxFilling.runId': 1 }
			).lean() as any[];
			const cartById = new Map(existingCarts.map((c: any) => [String(c._id), c]));

			const missing: string[] = [];
			const wrongStatus: { id: string; status: string }[] = [];
			const underTime: { id: string; remainingMin: number }[] = [];
			for (const cid of cartridgeIds) {
				const c = cartById.get(cid);
				if (!c) { missing.push(cid); continue; }
				// Idempotent retry: already stamped onto this run by a prior submit
				if (c.status === 'wax_filling' && c.waxFilling?.runId === runId) continue;
				if (c.status !== 'backing') { wrongStatus.push({ id: cid, status: c.status ?? '(none)' }); continue; }
				// CURE-TIME GATE SUSPENDED 2026-08-28 (operator decision). Nothing
				// blocks on oven time any more; the shortfall is still MEASURED so it
				// lands in the audit trail and so reinstating the gate is a one-line
				// change (turn the `underTime` list back into a fail()).
				const entry = c.backing?.ovenEntryTime ? new Date(c.backing.ovenEntryTime).getTime() : 0;
				const elapsedMin = entry ? (now.getTime() - entry) / 60000 : 0;
				if (!entry || elapsedMin < minOvenTimeMin) {
					underTime.push({ id: cid, remainingMin: Math.ceil(Math.max(0, minOvenTimeMin - elapsedMin)) });
				}
			}

			// Test mode: synthesize backed carts for unknown barcodes so the
			// flow can be exercised end-to-end without WI-01. Synthetic carts
			// have no backing.parentLotRecordId — cancel/abort deletes them.
			if (missing.length > 0 && testMode) {
				await CartridgeRecord.bulkWrite(missing.map((cid) => ({
					updateOne: {
						filter: { _id: cid },
						update: {
							$setOnInsert: {
								_id: cid,
								status: 'backing',
								'backing.ovenEntryTime': new Date(now.getTime() - minOvenTimeMin * 60000),
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
				return fail(400, { error: `Cartridge(s) not found in backing: ${missing.join(', ')}. Scan them into the oven at Cartridge Back (WI-01) first.` });
			}
			if (wrongStatus.length > 0) {
				return fail(400, { error: `Cartridge(s) not available for wax filling: ${wrongStatus.map((w) => `${w.id} (${w.status})`).join(', ')}.` });
			}
			// Oven cure time is NO LONGER ENFORCED (2026-08-28, operator: "completely
			// abolish the heating/oven timing requirement for wax carts — we might
			// reinstate it later"). Previously this refused the deck load and offered
			// an admin override; carts backed minutes earlier could not be filled.
			// The shortfall is still recorded on the run and in the audit log, so the
			// data to reinstate the gate (and to see how often it would have fired)
			// keeps accruing. To bring it back: return fail() here again — the client
			// already handles `requiresOverride` and the admin re-auth modal is intact.
			if (underTime.length > 0) {
				const worst = Math.max(...underTime.map((u) => u.remainingMin));
				console.log(`[loadDeck] cure-time gate suspended — proceeding with ${underTime.length} cartridge(s) under ${minOvenTimeMin} min (worst ${worst} min short)`);
				try {
					await AuditLog.create({
						_id: generateId(),
						tableName: 'cartridge_records',
						recordId: runId,
						action: 'UPDATE',
						changedBy: locals.user.username,
						changedAt: now,
						reason: `Cure-time gate suspended — ${underTime.length} cartridge(s) loaded under the ${minOvenTimeMin} min oven time (worst ${worst} min short)`,
						newData: { cureGateSuspended: true, minOvenTimeMin, cartridges: underTime }
					});
				} catch { /* never block the load on the note */ }
			}

			const ops = cartridgeIds.map((cid: string, idx: number) => ({
				updateOne: {
					filter: { _id: cid },
					update: {
						$set: {
							status: 'wax_filling',
							// Cartridge is leaving the backing oven onto the deck
							'backing.ovenExitTime': now,
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
	startRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const opentronsProtocolId = data.get('opentronsProtocolId')?.toString();
		if (!runId) return fail(400, { error: 'runId is required' });
		if (!opentronsProtocolId) return fail(400, { error: 'opentronsProtocolId is required (pick a protocol)' });

		const run = await WaxFillingRun.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Wax filling run not found' });
		const robotId = run.robot?._id;
		if (!robotId) return fail(400, { error: 'Wax run has no robot assigned' });

		// UNTRACKED-FILL GUARD (2026-08-28). Runs were starting with no scanned
		// deck and no cartridgeIds — the robot filled real carts that no record
		// ever pointed at, so nothing could mark them wax_filled. A run may only
		// start without them as an EXPLICIT test fill (calibration/tuning).
		const testFill = data.get('testFillNoCartridges')?.toString() === 'true';
		if (!testFill && (!run.deckId || !(run.cartridgeIds?.length))) {
			return fail(400, {
				error:
					'This run has no scanned deck/cartridges — starting now would fill carts no record points at ' +
					'(they could never be marked wax filled). Scan the deck + cartridges first, or tick ' +
					'"Test fill — no cartridges tracked" if this is a calibration run.'
			});
		}
		if (testFill && !(run.cartridgeIds?.length)) {
			try {
				await AuditLog.create({
					_id: generateId(), tableName: 'wax_filling_runs', recordId: runId, action: 'UPDATE',
					changedBy: locals.user?.username, changedAt: new Date(),
					newData: { testFillNoCartridges: true, note: 'explicit untracked test fill' }
				});
			} catch { /* non-fatal */ }
		}

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
		if (deckBinding.warning) console.warn('[wax-filling startRun] ' + deckBinding.warning);


		// Freshness gate: resolve the robot's CURRENT wax protocol server-side and
		// prove its bundled deck calibration matches live Mongo; auto-resync if
		// not. The posted opentronsProtocolId is intentionally NOT trusted — a page
		// loaded before a Sync would post the older upload, which still exists on
		// the robot and would silently run stale geometry.
		let protocol: { opentronsProtocolId: string; parametersSchema: any[] | null };
		try {
			protocol = await ensureFreshRunProtocol(robot, String(robotId), 'wax-filling', locals.user.username);
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
				// Operator didn't override; use protocol default.
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

		// Partial-deck runs (2026-08-18). The protocol's `cartridges` is the END
		// cartridge (it slices the first N cartridges of the destination list) and
		// `resume_cartridge` is the START. In BIMS `cartridges` is locked to the
		// number of cartridges the operator SCANNED into the run, so for a run that
		// starts partway (e.g. positions 16..24 = 9 scanned) the natural meaning is
		// "this many cartridges FROM the start". Translate count -> end here so the
		// operator never has to do that arithmetic (and can't get an empty run).
		const declared = new Set(paramSchema.map((d) => d.variableName));
		const startCart = Number(runTimeParameterValues['resume_cartridge'] ?? 1);
		if (declared.has('resume_cartridge') && startCart > 1) {
			const count = Number(runTimeParameterValues['cartridges'] ?? 24);
			const endCart = Math.min(24, startCart + count - 1);
			runTimeParameterValues['cartridges'] = endCart;
			protocolParameters['cartridges'] = endCart;
			protocolParameters['cartridgesScanned'] = count;
			console.log(`[wax startRun] partial deck: start cartridge ${startCart}, ${count} scanned -> end cartridge ${endCart}`);
		}

		// PRD 6: inject the BIMS-native calibration params (global offset +
		// calibrator point) for robots that have a captured offset. No-op for the
		// pre-cutover protocol (none of these RTPs declared) — see calibration-rtps.
		// Deck-keyed calibrator (2026-08-28): the fixture is bolted to the carriage,
		// so the run gets the point taught for the deck that is physically mounted —
		// deckBinding.particleDeviceId is the same id the .py reads at run start.
		const calRtps = await calibrationRtpValues(String(robotId), 'wax-filling', paramSchema as any, {
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
			if (!opentronsRunId) {
				return fail(502, { error: 'Robot returned no run id' });
			}

		// Geometry provenance. Record exactly which deck definition, at which
		// version and content hash, this run was started against — the definition
		// is edited in place, so these coordinates stop existing the moment anyone
		// jogs the deck again.
		try {
			await OpentronsRunRecord.create({
				_id: generateId(),
				manufacturingRunId: String(runId),
				manufacturingRunType: 'wax-filling',
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
			console.error('[wax-filling startRun] could not write run record:', e instanceof Error ? e.message : e);
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
					error: `Created run ${opentronsRunId} but couldn't start it: ${detail}. Operator can play it from the device page.`
				});
			}
		} catch (err) {
			return fail(502, {
				error: `Created run ${opentronsRunId} but couldn't start it: ${err instanceof Error ? err.message : 'unknown'}`
			});
		}

		// Auto-resume the protocol's initial off-deck "confirm deck loaded" pause
		// on the robot. The operator is routed to the gallery and won't be on the
		// run page to click Resume, so the daemon watches the run and resumes the
		// first pause once. Fire-and-forget.
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
			console.warn('[startRun] could not enqueue auto_resume_run:', e instanceof Error ? e.message : e);
		}

		// Carry the previous run's tip state forward as this run's "before"
		// snapshot. If the operator checked tiprack_refilled, the protocol
		// will reset to index 0 — record that intent so post-run consumed
		// math is sane (we treat refilled-mid-flight separately).
		const prevTipRun = await WaxFillingRun.findOne({
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

		const now = new Date();
		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: {
				status: 'Running',
				runStartTime: now,
				opentronsRunId,
				protocolParameters,
				'pipetteTipState.before': beforeSnap,
				'pipetteTipState.rackRefilledDuringRun': refilled
			}
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: {
				status: 'Running',
				opentronsRunId,
				protocolParameters,
				pipetteTipBefore: beforeSnap.nextTipIndex
			}
		});

		return { success: true, opentronsRunId };
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
		if (!runId) return fail(400, { error: 'runId is required' });

		const run = await WaxFillingRun.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Wax filling run not found' });
		if (!run.opentronsRunId) return fail(400, { error: 'This wax run has no OT-2 run linked' });
		if (run.pipetteTipState?.after?.nextTipIndex != null) {
			// Idempotent: already recorded. Return success without re-fetching.
			return { success: true, alreadyRecorded: true };
		}

		const robot = await getRobot(run.robot?._id);
		if (!robot) return fail(404, { error: 'Robot no longer reachable' });

		// Pull commands. The OT-2 paginates — request a large pageLength to
		// get everything in one round-trip for a typical wax run (well under
		// 10k commands).
		let nextTipIndex: number | null = null;
		let hostname: string | null = null;
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
						// "TIP TRACKER: consumed tip A37 — next tip will be A38 (index 24)"
						// "TIP TRACKER: starting from tip A37 (index 24)"
						const m = cmd.params.message.match(/TIP TRACKER:[\s\S]*?\(index (\d+)\)/);
						if (m) nextTipIndex = parseInt(m[1], 10);
					}
				}
			}
		} catch (err) {
			console.error('[WAX-FILLING] recordRunFinished: command fetch failed:', err);
			// Fall through — still stamp partial state.
		}

		const now = new Date();
		const before = run.pipetteTipState?.before?.nextTipIndex ?? 0;
		const refilledMidRun = !!run.pipetteTipState?.rackRefilledDuringRun;
		// If the rack was refilled mid-run, consumed = (96 - before) + (final index).
		// Otherwise just the delta.
		const finalIndex = nextTipIndex ?? before + pickUpTipCount;
		const consumed = refilledMidRun
			? Math.max(0, 96 - before) + finalIndex
			: Math.max(0, finalIndex - before);

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: {
				// Persist the terminal .py status on the run so the Running stage can
				// reveal the deck-removal + Run-again controls after it finishes (reload-safe).
				opentronsRunFinalStatus: finalStatus || 'unknown',
				'pipetteTipState.after': {
					nextTipIndex: finalIndex,
					hostname: hostname ?? run.pipetteTipState?.before?.hostname ?? null,
					capturedAt: now
				},
				'pipetteTipState.consumed': consumed
			}
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
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

		// AUTO-ADVANCE (2026-08-28): a run that completes with no cancellation IS
		// the statement that every cart on it got wax. No deck-removed / fridge
		// ceremony — flip the whole run to wax_filled and complete it right here.
		// Stopped/failed runs are left for cancel/abort (smart abort advances only
		// the carts the robot log proves were finished).
		let advanced = 0;
		if (finalStatus === 'succeeded') {
			const user = { _id: locals.user!._id, username: locals.user!.username };
			const r = await advanceCartsToWaxFilled(run, run.cartridgeIds ?? [], user, 'run-complete auto-advance');
			advanced = r.advanced;
			await WaxFillingRun.findByIdAndUpdate(runId, {
				$set: { status: 'completed', robotReleasedAt: now, runEndTime: now }
			});
		}

		return { success: true, consumed, nextTipIndex: finalIndex, advanced, autoCompleted: finalStatus === 'succeeded' };
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
		const now = new Date();

		// Once the OT-2 has finished (robotReleasedAt set), the run is committed
		// and can no longer be cancelled. Individual cartridges can still be
		// rejected at QC; whole-run abort is no longer the right tool.
		const existing = await WaxFillingRun.findById(runId).select('robotReleasedAt').lean() as any;
		if (existing?.robotReleasedAt) {
			return fail(400, { error: 'Cannot cancel: the OT-2 has already completed this run. Reject individual cartridges at QC instead.' });
		}

		const runBeforeCancel = await WaxFillingRun.findById(runId).select('cartridgeIds opentronsRunId robot deckId waxTubeId waxSourceLot operator runStartTime protocolParameters').lean() as any;
		const cancelScannedIds: string[] = (runBeforeCancel?.cartridgeIds ?? []) as string[];

		// Actually halt the OT-2 first — otherwise the robot keeps running.
		const cancelRobotWarning = await stopRobotRun(runBeforeCancel);

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'aborted', abortReason: reason, runEndTime: now }
		});

		// SMART ABORT (2026-08-28): the robot's own log proves which carts it
		// finished before the stop — mark THOSE wax_filled instead of reverting
		// real fills to backing. Only fully-filled carts count.
		if (cancelScannedIds.length > 0 && runBeforeCancel?.opentronsRunId) {
			try {
				const cRobot = await getRobot(runBeforeCancel.robot?._id);
				if (cRobot) {
					const filled = await cartsFilledPerRobotLog(cRobot, runBeforeCancel.opentronsRunId, runBeforeCancel);
					const filledIds = [...filled].map((n) => cancelScannedIds[n - 1]).filter(Boolean);
					if (filledIds.length > 0) {
						const r = await advanceCartsToWaxFilled(runBeforeCancel, filledIds, { _id: locals.user!._id, username: locals.user!.username }, 'smart-abort (cancel)');
						console.log(`[cancelRun] smart abort: ${r.advanced} filled cart(s) marked wax_filled before revert`);
					}
				}
			} catch (e) {
				console.error('[cancelRun] smart abort check failed (reverting all):', e instanceof Error ? e.message : e);
			}
		}

		// Cartridges scanned onto the deck never actually got wax-filled.
		// WI-01-originated carts go back to 'backing' (the operator returns
		// them to the oven; their original ovenEntryTime is preserved).
		// Test-mode synthetics (no parentLotRecordId) are deleted.
		if (cancelScannedIds.length > 0) {
			await CartridgeRecord.updateMany(
				{
					_id: { $in: cancelScannedIds },
					'waxFilling.runId': runId,
					status: 'wax_filling',
					'backing.parentLotRecordId': { $exists: true, $ne: null }
				},
				{ $set: { status: 'backing' }, $unset: { waxFilling: '', 'backing.ovenExitTime': '' } }
			);
			await CartridgeRecord.deleteMany({
				_id: { $in: cancelScannedIds },
				'waxFilling.runId': runId,
				status: 'wax_filling'
			});
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { status: 'aborted', abortReason: reason, revertedToBacking: cancelScannedIds.length }
		});

		await notifyRunLifecycle({
			runId, runType: 'wax_filling', status: 'cancelled',
			operator: locals.user?.username, reason
		});

		return { success: true, warning: cancelRobotWarning ?? undefined };
	},

	abortRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const reason = (data.get('reason') as string) || 'Aborted';
		const now = new Date();

		// Once the OT-2 has finished (robotReleasedAt set), abort is no longer
		// available — same rule as cancelRun. Per-cartridge rejection at QC
		// is the post-run path.
		const existing = await WaxFillingRun.findById(runId).select('robotReleasedAt').lean() as any;
		if (existing?.robotReleasedAt) {
			return fail(400, { error: 'Cannot abort: the OT-2 has already completed this run. Reject individual cartridges at QC instead.' });
		}

		const runBeforeAbort = await WaxFillingRun.findById(runId).select('cartridgeIds opentronsRunId robot deckId waxTubeId waxSourceLot operator runStartTime protocolParameters').lean() as any;
		const abortScannedIds: string[] = (runBeforeAbort?.cartridgeIds ?? []) as string[];

		// Actually halt the OT-2 first — otherwise the robot keeps running.
		const abortRobotWarning = await stopRobotRun(runBeforeAbort);

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'aborted', abortReason: reason, runEndTime: now }
		});

		// SMART ABORT — see cancelRun: robot-proven filled carts advance instead
		// of reverting to backing.
		if (abortScannedIds.length > 0 && runBeforeAbort?.opentronsRunId) {
			try {
				const aRobot = await getRobot(runBeforeAbort.robot?._id);
				if (aRobot) {
					const filled = await cartsFilledPerRobotLog(aRobot, runBeforeAbort.opentronsRunId, runBeforeAbort);
					const filledIds = [...filled].map((n) => abortScannedIds[n - 1]).filter(Boolean);
					if (filledIds.length > 0) {
						const r = await advanceCartsToWaxFilled(runBeforeAbort, filledIds, { _id: locals.user!._id, username: locals.user!.username }, 'smart-abort');
						console.log(`[abortRun] smart abort: ${r.advanced} filled cart(s) marked wax_filled before revert`);
					}
				}
			} catch (e) {
				console.error('[abortRun] smart abort check failed (reverting all):', e instanceof Error ? e.message : e);
			}
		}

		// Same revert semantics as cancelRun — see comment there.
		if (abortScannedIds.length > 0) {
			await CartridgeRecord.updateMany(
				{
					_id: { $in: abortScannedIds },
					'waxFilling.runId': runId,
					status: 'wax_filling',
					'backing.parentLotRecordId': { $exists: true, $ne: null }
				},
				{ $set: { status: 'backing' }, $unset: { waxFilling: '', 'backing.ovenExitTime': '' } }
			);
			await CartridgeRecord.deleteMany({
				_id: { $in: abortScannedIds },
				'waxFilling.runId': runId,
				status: 'wax_filling'
			});
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { status: 'aborted', abortReason: reason, revertedToBacking: abortScannedIds.length }
		});

		await notifyRunLifecycle({
			runId, runType: 'wax_filling', status: 'aborted',
			operator: locals.user?.username, reason
		});

		return { success: true, warning: abortRobotWarning ?? undefined };
	},




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
			action: cancel ? 'wax_tip_swap_cancel' : 'wax_tip_swap_request',
			resourceType: 'wax_filling_run',
			resourceId: runId,
			userId: locals.user._id,
			username: locals.user.username,
			timestamp: new Date(),
			details: { mode, opentronsRunId: run.opentronsRunId ?? null }
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
