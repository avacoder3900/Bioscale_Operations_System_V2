import { redirect, fail } from '@sveltejs/kit';
import mongoose from 'mongoose';
import {
	connectDB, WaxFillingRun, CartridgeRecord, Consumable, ManufacturingSettings, generateId,
	Equipment, EquipmentLocation, AuditLog, BackingLot, WaxBatch, ReceivingLot,
	OpentronsRobot, ManualCartridgeRemoval
} from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import { resolveFridgeId, resolveCoolingTrayId, resolveDeckId } from '$lib/server/services/equipment-resolve';
import { isAdmin } from '$lib/server/permissions';
import { User } from '$lib/server/db';
import { notifyLowWaxBatch, notifyRunLifecycle, shouldWarnLowWax } from '$lib/server/notifications';
import { checkRobotConflict, checkDeckConflict, checkTrayConflict } from '$lib/server/manufacturing/resource-locks';
import { protectLockedCarts, LOCKED_STATUSES } from '$lib/server/manufacturing/locked-cartridges';
import { getRobot, robotGet, robotPost } from '$lib/server/opentrons/proxy';
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
		qcCartridges: [] as any[],
		storageCartridges: [] as any[],
		lockedCartridges: [] as { cartridgeId: string; status: string }[],
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

		const run = activeWaxRun as any;
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
				// Mirror the parameter set the operator chose for this run so the
				// page can show "what we asked the robot to do" after the fact.
				protocolParameters: run.protocolParameters ?? null
			}
			: { hasActiveRun: false, runId: null, stage: null, runStartTime: null, runEndTime: null, deckRemovedTime: null, deckId: null, waxSourceLot: null, coolingTrayId: null, plannedCartridgeCount: null, coolingConfirmedAt: null, existingWaxRunNote: '', opentronsRunId: null, protocolParameters: null };

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

		// QC cartridges (wax_filled phase, for this robot's run)
		const qcCartridgesRaw = run
			? await CartridgeRecord.find({ 'waxFilling.runId': String(run._id) }).lean().catch(() => [])
			: [];

		const qcCartridges = (qcCartridgesRaw as any[]).map((c: any) => ({
			cartridgeId: String(c._id),
			backedLotId: c.backing?.lotId ?? '',
			ovenEntryTime: c.backing?.ovenEntryTime ? new Date(c.backing.ovenEntryTime).toISOString() : null,
			waxRunId: c.waxFilling?.runId ? String(c.waxFilling.runId) : null,
			deckPosition: c.waxFilling?.deckPosition ?? null,
			waxTubeId: c.waxFilling?.waxTubeId ?? null,
			coolingTrayId: c.waxStorage?.coolingTrayId ?? null,
			transferTimeSeconds: c.waxFilling?.transferTimeSeconds ?? null,
			qcStatus: c.waxQc?.status ?? 'Pending',
			rejectionReason: c.waxQc?.rejectionReason ?? null,
			qcTimestamp: c.waxQc?.timestamp ? new Date(c.waxQc.timestamp).toISOString() : null,
			currentInventory: c.status ?? 'wax_filled',
			storageLocation: c.waxStorage?.location ?? null,
			storageTimestamp: c.waxStorage?.timestamp ? new Date(c.waxStorage.timestamp).toISOString() : null,
			storageOperatorId: c.waxStorage?.operator?._id ? String(c.waxStorage.operator._id) : null,
			createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : '',
			updatedAt: c.updatedAt ? new Date(c.updatedAt).toISOString() : ''
		}));

		// Storage cartridges — all cartridges linked to this run
		const storageCartridgesRaw = run
			? await CartridgeRecord.find({ 'waxFilling.runId': String(run._id) }).lean().catch(() => [])
			: [];

		// Split off carts the wax flow can't touch any more (relinked to an SPU,
		// already completed, voided, scrapped). protectLockedCarts will silently
		// filter them out of every wax-flow write, so showing them in the
		// "needs storage" list strands the run forever. Surface them separately
		// so the operator sees what was pulled off the run and can still
		// Complete Run for the rest.
		const lockedCartridges = (storageCartridgesRaw as any[])
			.filter((c: any) => (LOCKED_STATUSES as readonly string[]).includes(c.status))
			.map((c: any) => ({ cartridgeId: String(c._id), status: c.status }));
		const storageCartridges = (storageCartridgesRaw as any[])
			.filter((c: any) => !(LOCKED_STATUSES as readonly string[]).includes(c.status))
			.map((c: any) => ({
				cartridgeId: String(c._id),
				qcStatus: c.waxQc?.status ?? 'Accepted',
				// Derive UI "stored" state from waxStorage.recordedAt rather than
				// status. status stays 'wax_filled' until completeRun (deferred
				// commit, see 581c0d7) — but the UI needs to flip the moment
				// recordBatchStorage runs so CompletionStorage transitions to its
				// review state and Complete Run becomes clickable.
				currentInventory: c.waxStorage?.recordedAt ? 'wax_stored' : (c.status ?? 'wax_filled'),
				storageLocation: c.waxStorage?.location ?? null
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
			const isReady = entry > 0 && (now - entry) / 60000 >= minOvenTimeMin;
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
			qcCartridges,
			storageCartridges,
			lockedCartridges,
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
	recordWaxPrep: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const waxSourceLot = (data.get('waxSourceLot') as string)?.trim() || '';
		const plannedCartridgeCount = data.get('plannedCartridgeCount') ? Number(data.get('plannedCartridgeCount')) : 24;

		if (!runId) return fail(400, { error: 'Run ID required' });
		if (!waxSourceLot) return fail(400, { error: 'Select a wax lot' });
		if (!plannedCartridgeCount || plannedCartridgeCount < 1 || plannedCartridgeCount > 24) {
			return fail(400, { error: 'Cartridge count must be 1-24' });
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
			if (underTime.length > 0 && !testMode) {
				if (override) {
					const verified = await verifyAdminOverride(adminUser, adminPass);
					if (!verified.ok) {
						return fail(403, { error: verified.error, requiresOverride: true });
					}
					await AuditLog.create({
						_id: generateId(),
						tableName: 'cartridge_records',
						recordId: runId,
						action: 'UPDATE',
						changedBy: verified.user.username,
						changedAt: now,
						reason: `Wax cure time override by admin — ${underTime.length} cartridge(s) under ${minOvenTimeMin} min`,
						newData: {
							override: true,
							operatorUsername: locals.user.username,
							adminUsername: verified.user.username,
							minOvenTimeMin,
							cartridges: underTime
						}
					});
				} else {
					const worst = Math.max(...underTime.map((u) => u.remainingMin));
					return fail(400, {
						error: `${underTime.length} cartridge(s) have not finished the ${minOvenTimeMin} min oven time (up to ${worst} min remaining). Wait, or get an admin to override.`,
						requiresOverride: true
					});
				}
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

		const robot = await getRobot(robotId);
		if (!robot) return fail(404, { error: `Robot ${robotId} not found / not active` });

		// Resolve the protocol on the robot to coerce form-string values to
		// their native types (int/float/bool). Form fields all arrive as
		// strings; the OT-2 API expects e.g. true (bool) not "true" (str).
		const robotDoc = await OpentronsRobot.findById(robotId).lean() as any;
		const protocol = (robotDoc?.protocols ?? []).find(
			(p: any) => p.opentronsProtocolId === opentronsProtocolId
		);
		if (!protocol) {
			return fail(400, {
				error: `Protocol ${opentronsProtocolId} isn't uploaded to this robot. Upload it via /opentrons/devices first.`
			});
		}

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

		// Create the OT-2 run.
		let opentronsRunId: string;
		try {
			const createRes = await robotPost(robot, '/runs', {
				data: {
					protocolId: opentronsProtocolId,
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

		return { success: true, consumed, nextTipIndex: finalIndex };
	},

	/** Confirm deck removed — transition Running → Awaiting Removal; record oven entry */
	confirmDeckRemoved: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const ovenLocationId = (data.get('ovenLocationId') as string) || undefined;
		const ovenLocationName = (data.get('ovenLocationName') as string) || undefined;
		const now = new Date();

		const run = await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: {
				status: 'Awaiting Removal',
				deckRemovedTime: now,
				// Robot is physically free as of now — releases the robot lock so a
				// new wax/reagent run can start on the same OT-2 while the cooling/
				// QC/storage steps continue detached on Opentron Control.
				robotReleasedAt: now,
				...(ovenLocationId ? { ovenLocationId } : {})
			}
		}, { new: true }).lean() as any;

		// Robot is now free. ovenCure writes happen later on Opentron Control
		// when the operator scans the curing oven at the "Deck Placed in Oven"
		// step. The page's load function will no longer find this run as "active"
		// (robotReleasedAt filters it out), so invalidateAll() will reset the
		// page to "Start new run".
		return { success: true };
	},

	/** Confirm cooling — transition Awaiting Removal → QC; record oven exit */
	confirmCooling: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = await resolveWaxRunId(data);
		const coolingTrayId = (data.get('coolingTrayId') as string) || undefined;
		const now = new Date();

		if (!runId) return fail(404, { error: 'Run not found' });

		// Tray conflict runs at scan time (see /api/dev/validate-equipment
		// ?type=tray). No duplicate check here.

		// S2b: resolve cooling tray to canonical Equipment._id
		let resolvedTrayId: string | undefined;
		if (coolingTrayId) {
			const resolved = await resolveCoolingTrayId(coolingTrayId);
			if (!resolved) return fail(400, { error: `Unknown cooling tray: ${coolingTrayId}` });
			resolvedTrayId = resolved;
		}

		// Resolve the fridge this tray currently lives in (inferred from
		// EquipmentLocation.currentPlacements). Degrades gracefully: if the
		// tray has no placement, we still record the cooling but skip the
		// fridge fields and log a warning.
		let coolingLocationId: string | undefined;
		let coolingLocationName: string | undefined;
		if (resolvedTrayId) {
			const fridgeLoc = await EquipmentLocation.findOne({
				locationType: 'fridge',
				isActive: true,
				currentPlacements: { $elemMatch: { itemId: resolvedTrayId } }
			}).lean().catch(() => null) as any;
			if (fridgeLoc) {
				coolingLocationId = String(fridgeLoc._id);
				coolingLocationName = fridgeLoc.displayName ?? fridgeLoc.barcode ?? undefined;
			} else {
				console.warn(`[confirmCooling] No fridge placement found for tray ${resolvedTrayId}`);
			}
		}

		const update: Record<string, any> = { status: 'QC', coolingConfirmedTime: now, coolingConfirmedAt: now };
		if (resolvedTrayId) update.coolingTrayId = resolvedTrayId;
		if (coolingLocationId) update.coolingLocationId = coolingLocationId;

		const run = await WaxFillingRun.findByIdAndUpdate(runId, { $set: update }, { new: true }).lean() as any;

		// Record oven exit time on cartridges that have an ovenCure.entryTime
		// and stamp the cooling fridge on each cartridge's waxStorage subdoc.
		// Locked carts (linked/underway/completed/voided/scrapped) are skipped + logged.
		if (run?.cartridgeIds?.length) {
			const { safeIds } = await protectLockedCarts(
				run.cartridgeIds,
				'confirmCooling',
				runId,
				{ _id: locals.user!._id, username: locals.user!.username }
			);

			if (safeIds.length > 0) {
				const waxStorageSet: Record<string, any> = {};
				if (coolingTrayId) waxStorageSet['waxStorage.coolingTrayId'] = coolingTrayId;
				if (coolingLocationId) waxStorageSet['waxStorage.coolingLocationId'] = coolingLocationId;
				if (coolingLocationName) waxStorageSet['waxStorage.coolingLocationName'] = coolingLocationName;

				const bulkOps = safeIds.map((cid: string) => ({
					updateOne: {
						filter: { _id: cid, 'ovenCure.entryTime': { $exists: true }, 'ovenCure.exitTime': { $exists: false } },
						update: { $set: { 'ovenCure.exitTime': now, ...waxStorageSet } }
					}
				}));
				await CartridgeRecord.bulkWrite(bulkOps);
			}
		}

		return { success: true, coolingLocationId, coolingLocationName };
	},

	/** Complete QC — inspect all cartridges and transition to Storage */
	completeQC: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = (data.get('runId') as string)?.trim();
		const now = new Date();

		if (!runId) return fail(404, { error: 'Run not found' });

		// Idempotency: if a prior click flipped status='Storage' but a
		// downstream side-effect threw, re-firing would duplicate inventory
		// rows + waxQc writes. Treat as success.
		const runBeforeQc = await WaxFillingRun.findById(runId).select('coolingConfirmedAt status').lean() as any;
		if (!runBeforeQc) return fail(404, { error: 'Run not found' });
		if (runBeforeQc.status === 'Storage' || runBeforeQc.status === 'storage' || runBeforeQc.status === 'completed') {
			return { success: true };
		}

		// Server-side cooling timer check: minimum cool-down before QC.
		// Configurable via ManufacturingSettings.waxFilling.minCoolingBeforeQcMin
		// (default 2 min). Editable from the wax-filling settings page.
		if (runBeforeQc?.coolingConfirmedAt) {
			const settingsDocQc = await ManufacturingSettings.findById('default').select('waxFilling.minCoolingBeforeQcMin').lean() as any;
			const minCoolMin = settingsDocQc?.waxFilling?.minCoolingBeforeQcMin ?? 2;
			const minCoolMs = minCoolMin * 60 * 1000;
			const elapsedMs = Date.now() - new Date(runBeforeQc.coolingConfirmedAt).getTime();
			if (elapsedMs < minCoolMs) {
				const remainingMin = Math.ceil((minCoolMs - elapsedMs) / 60000);
				return fail(400, { error: `Cartridges must cool for at least ${minCoolMin} minute${minCoolMin === 1 ? '' : 's'} before QC inspection. ${remainingMin} minute${remainingMin === 1 ? '' : 's'} remaining.` });
			}
		}

		const run = await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'Storage', runEndTime: now }
		}, { new: true }).lean() as any;

		// Write waxFilling phase to all cartridges (WRITE-ONCE).
		// Locked carts (linked/underway/completed/voided/scrapped) are skipped + audited.
		if (run?.cartridgeIds?.length) {
			const { safeIds } = await protectLockedCarts(
				run.cartridgeIds,
				'completeQC',
				runId,
				{ _id: locals.user!._id, username: locals.user!.username }
			);

			if (safeIds.length > 0) {
				const bulkOps = safeIds.map((cid: string) => ({
					updateOne: {
						filter: { _id: cid, 'waxFilling.recordedAt': { $exists: false } },
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
				await CartridgeRecord.bulkWrite(bulkOps);

				// Write waxQc.status='Accepted' for every cartridge that wasn't rejected
				// during QC. Rejects already carry waxQc.recordedAt (from rejectCartridge),
				// so the recordedAt-not-set filter excludes them.
				const acceptOps = safeIds.map((cid: string) => ({
					updateOne: {
						filter: { _id: cid, 'waxQc.recordedAt': { $exists: false }, status: { $ne: 'scrapped' } },
						update: {
							$set: {
								'waxQc.status': 'Accepted',
								'waxQc.operator': { _id: locals.user!._id, username: locals.user!.username },
								'waxQc.timestamp': now,
								'waxQc.recordedAt': now
							}
						}
					}
				}));
				await CartridgeRecord.bulkWrite(acceptOps);

				// Record inventory transactions for each cartridge — consume wax (PT-CT-105)
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
							notes: `Wax-filled cartridge created in run ${run._id}`
						});
					}
				} catch (e) {
					console.error('[completeQC] consumption recordTransaction failed:', e instanceof Error ? e.message : e);
				}
			}
		}

		try {
			await AuditLog.create({
				_id: generateId(),
				tableName: 'wax_filling_runs',
				recordId: runId,
				action: 'UPDATE',
				changedBy: locals.user?.username,
				changedAt: now,
				newData: { status: 'Storage' }
			});
		} catch (e) {
			console.error('[completeQC] audit log failed:', e instanceof Error ? e.message : e);
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

		const runBeforeCancel = await WaxFillingRun.findById(runId).select('cartridgeIds').lean() as any;
		const cancelScannedIds: string[] = (runBeforeCancel?.cartridgeIds ?? []) as string[];

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'aborted', abortReason: reason, runEndTime: now }
		});

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

		return { success: true };
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

		const runBeforeAbort = await WaxFillingRun.findById(runId).select('cartridgeIds').lean() as any;
		const abortScannedIds: string[] = (runBeforeAbort?.cartridgeIds ?? []) as string[];

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'aborted', abortReason: reason, runEndTime: now }
		});

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

		return { success: true };
	},

	/** Reject a cartridge during QC */
	rejectCartridge: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const cartridgeId = data.get('cartridgeId') as string;
		const rejectionReason = (data.get('rejectionReason') as string) || '';
		const now = new Date();

		// If the cart is already linked/underway/completed/voided/scrapped,
		// don't overwrite — log the attempt and refuse.
		const { safeIds, blockedDetails } = await protectLockedCarts(
			[cartridgeId],
			'rejectCartridge',
			undefined,
			{ _id: locals.user!._id, username: locals.user!.username }
		);
		if (safeIds.length === 0) {
			return fail(400, {
				error: `Cannot reject — cartridge is at status="${blockedDetails[0]?.status}" (already in SPU testing or finalized). The attempt has been logged.`
			});
		}

		// Wax rejects use status='scrapped' (distinct from the generic 'voided'
		// used by operator-initiated removals). Cartridge stays in the system
		// so inventory + traceability queries can still find it.
		await CartridgeRecord.findOneAndUpdate(
			{ _id: cartridgeId, 'waxQc.recordedAt': { $exists: false } },
			{
				$set: {
					'waxQc.status': 'Rejected',
					'waxQc.rejectionReason': rejectionReason,
					'waxQc.operator': { _id: locals.user!._id, username: locals.user!.username },
					'waxQc.timestamp': now,
					'waxQc.recordedAt': now,
					status: 'scrapped',
					voidedAt: now,
					voidReason: `Wax QC rejection: ${rejectionReason}`
				}
			}
		);

		// Record scrap transaction
		await recordTransaction({
			transactionType: 'scrap',
			cartridgeRecordId: cartridgeId,
			quantity: 1,
			manufacturingStep: 'wax_filling',
			operatorId: locals.user._id,
			operatorUsername: locals.user.username,
			scrapReason: rejectionReason,
			scrapCategory: 'wax_defect',
			notes: `Wax QC rejection: ${rejectionReason}`
		});

		return { success: true };
	},

	/** Record storage location for cartridges */
	recordBatchStorage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const cartridgeIdsRaw = data.get('cartridgeIds') as string;
		const location = data.get('storageLocation') as string;
		const coolingTrayId = (data.get('coolingTrayId') as string) || undefined;

		let cartridgeIds: string[] = [];
		try {
			cartridgeIds = JSON.parse(cartridgeIdsRaw);
		} catch {
			return fail(400, { error: 'Invalid cartridge IDs' });
		}

		// Guard: completeQC must have landed before storage. If any cart is still
		// at status='wax_filling', writing waxStorage now would leave it stranded
		// — completeRun's wax_filled→wax_stored flip is filtered on status, so the
		// cart would sit at 'wax_filling' with waxStorage set forever. Caused a
		// 37-cart incident on 2026-05-04 when completeQC 500'd mid-action.
		const stillFilling = await CartridgeRecord.find({
			_id: { $in: cartridgeIds },
			status: 'wax_filling'
		}).select('_id').lean() as any[];
		if (stillFilling.length > 0) {
			const idList = stillFilling.map(c => c._id).join(', ');
			return fail(400, {
				error: `Cannot record storage — ${stillFilling.length} cartridge${stillFilling.length === 1 ? '' : 's'} still at status 'wax_filling' (completeQC did not land). Re-run QC inspection before assigning a fridge. Stuck IDs: ${idList.slice(0, 300)}`
			});
		}

		// Resolve the fridge for this batch: first try the storageLocation
		// string (it may be an EquipmentLocation _id or barcode); if that
		// misses, fall back to the tray's current placement.
		let coolingLocationId: string | undefined;
		let coolingLocationName: string | undefined;
		if (location) {
			const direct = await EquipmentLocation.findOne({
				locationType: 'fridge',
				isActive: true,
				$or: [{ _id: location }, { barcode: location }]
			}).lean().catch(() => null) as any;
			if (direct) {
				coolingLocationId = String(direct._id);
				coolingLocationName = direct.displayName ?? direct.barcode ?? undefined;
			}
		}
		if (!coolingLocationId && coolingTrayId) {
			const byTray = await EquipmentLocation.findOne({
				locationType: 'fridge',
				isActive: true,
				currentPlacements: { $elemMatch: { itemId: coolingTrayId } }
			}).lean().catch(() => null) as any;
			if (byTray) {
				coolingLocationId = String(byTray._id);
				coolingLocationName = byTray.displayName ?? byTray.barcode ?? undefined;
			} else {
				console.warn(`[recordBatchStorage] No fridge placement found for tray ${coolingTrayId}`);
			}
		}

		// Locked carts (linked/underway/completed/voided/scrapped) skipped + audited.
		// Derive runId from the first cart's waxFilling.runId for the audit log.
		const firstCart = cartridgeIds[0]
			? await CartridgeRecord.findById(cartridgeIds[0]).select('waxFilling.runId').lean() as any
			: null;
		const inferredRunId: string | undefined = firstCart?.waxFilling?.runId;
		const { safeIds, blockedDetails } = await protectLockedCarts(
			cartridgeIds,
			'recordBatchStorage',
			inferredRunId,
			{ _id: locals.user!._id, username: locals.user!.username }
		);

		const now = new Date();
		// S1a: resolve the scanned fridge reference to Equipment._id. See
		// opentron-control/wax/[runId]/+page.server.ts for the same pattern.
		const resolvedLocationId = await resolveFridgeId(location);
		// S2b: pre-resolve cooling tray here (outside the .map below) because
		// the map callback is sync and can't await — same pattern as the
		// sibling opentron-control route.
		const resolvedTrayId = coolingTrayId ? await resolveCoolingTrayId(coolingTrayId) : null;
		if (safeIds.length > 0) {
			// Storage fields only — status stays 'wax_filled' until completeRun.
			// Keeps reagent filling from picking up cartridges whose parent wax
			// run is still open.
			const bulkOps = safeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'waxStorage.recordedAt': { $exists: false } },
					update: {
						$set: {
							'waxStorage.locationId': resolvedLocationId,
							'waxStorage.location': location,
							'waxStorage.coolingTrayId': resolvedTrayId ?? coolingTrayId,
							...(coolingLocationId ? { 'waxStorage.coolingLocationId': coolingLocationId } : {}),
							...(coolingLocationName ? { 'waxStorage.coolingLocationName': coolingLocationName } : {}),
							'waxStorage.operator': { _id: locals.user!._id, username: locals.user!.username },
							'waxStorage.timestamp': now,
							'waxStorage.recordedAt': now
							// status intentionally NOT set — completeRun does the wax_stored flip.
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(bulkOps);

			// Record storage transactions
			for (const cid of safeIds) {
				await recordTransaction({
					transactionType: 'creation',
					cartridgeRecordId: cid,
					quantity: 1,
					manufacturingStep: 'storage',
					operatorId: locals.user._id,
					operatorUsername: locals.user.username,
					notes: `Wax storage: ${location}${coolingTrayId ? `, tray ${coolingTrayId}` : ''}${coolingLocationName ? `, fridge ${coolingLocationName}` : ''}`
				});
			}

			// Audit log for batch storage
			await AuditLog.create({
				_id: generateId(),
				tableName: 'cartridge_records',
				recordId: safeIds[0] ?? 'batch',
				action: 'UPDATE',
				changedBy: locals.user?.username,
				changedAt: now,
				newData: { status: 'wax_stored', location, coolingLocationId, coolingLocationName, count: safeIds.length, skippedLockedCount: blockedDetails.length }
			});
		}

		return {
			success: true,
			coolingLocationId,
			coolingLocationName,
			skippedLockedCount: blockedDetails.length,
			skippedCarts: blockedDetails.map((b) => ({ cartridgeId: b._id, status: b.status }))
		};
	},

	/**
	 * Clear waxStorage fields on every cartridge in the run so the operator can
	 * re-pick fridges. Only allowed while the run is still in Storage stage —
	 * once completeRun has flipped status to 'completed', the assignments are
	 * locked. Mirrors the action in opentron-control/wax/[runId]/+page.server.ts
	 * — fix bugs in both.
	 */
	reassignStorage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const now = new Date();

		const run = await WaxFillingRun.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });
		if (run.status !== 'Storage' && run.status !== 'storage') {
			return fail(400, { error: `Cannot reassign — run status is "${run.status}". Reassign is only allowed during Storage stage.` });
		}

		const cartIds: string[] = run.cartridgeIds ?? [];
		if (cartIds.length === 0) return { success: true };

		// Skip locked carts (linked/underway/completed/voided/scrapped) — clearing
		// waxStorage on a cart already in SPU testing would invalidate downstream state.
		const { safeIds, blockedDetails } = await protectLockedCarts(
			cartIds,
			'reassignStorage',
			runId,
			{ _id: locals.user!._id, username: locals.user!.username }
		);
		if (safeIds.length === 0) {
			return {
				success: true,
				skippedLockedCount: blockedDetails.length,
				skippedCarts: blockedDetails.map((b) => ({ cartridgeId: b._id, status: b.status }))
			};
		}

		await CartridgeRecord.updateMany(
			{ _id: { $in: safeIds } },
			{ $unset: { waxStorage: '' } }
		);

		await mongoose.connection.db!.collection('inventory_transactions').updateMany(
			{
				cartridgeRecordId: { $in: safeIds },
				manufacturingStep: 'storage',
				transactionType: 'creation',
				retractedAt: { $exists: false }
			},
			{
				$set: {
					retractedBy: locals.user?.username ?? 'unknown',
					retractedAt: now,
					retractionReason: 'Reassign storage — operator changing fridge selection'
				}
			}
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: safeIds[0] ?? 'batch',
			action: 'REASSIGN_STORAGE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { runId, count: safeIds.length, reason: 'Operator-initiated reassignment', skippedLockedCount: blockedDetails.length }
		});

		return {
			success: true,
			skippedLockedCount: blockedDetails.length,
			skippedCarts: blockedDetails.map((b) => ({ cartridgeId: b._id, status: b.status }))
		};
	},

	/**
	 * Save an operator-entered note against the wax run. Append-only metadata —
	 * does NOT mutate run status, cartridge status, or any lifecycle field. The
	 * note is mirrored to every cartridge currently on the run (phase='wax_run')
	 * AND to WaxFillingRun.notes[] so run-history surfaces can read run.notes
	 * directly. At most one wax_run note per cartridge — re-saving overwrites.
	 */
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

	/** Complete the full run */
	completeRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = (data.get('runId') as string)?.trim();
		const now = new Date();

		if (!runId) return fail(404, { error: 'Run not found' });

		// Idempotency: if a prior click flipped status='completed' but a
		// downstream side-effect threw, re-firing would double-count inventory
		// and push duplicate audit rows. Treat as success.
		const existingRun = await WaxFillingRun.findById(runId).select('status').lean() as any;
		if (!existingRun) return fail(404, { error: 'Run not found' });
		if (existingRun.status === 'completed') {
			return { success: true };
		}

		const run = await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'completed', runEndTime: now }
		}, { new: true }).lean() as any;

		// Update consumable usage logs
		const cartridgeCount = run?.cartridgeIds?.length ?? 0;
		const operatorRef = { _id: locals.user!._id, username: locals.user!.username };

		// Commit point: flip wax_filled → wax_stored for every cartridge that
		// made it through fridge assignment. Mirrors the flip in
		// opentron-control/wax/[runId]/+page.server.ts completeRun.
		// The status='wax_filled' filter already excludes locked carts; the
		// helper call still runs so improper-order attempts are logged + visible.
		if (run?.cartridgeIds?.length) {
			await protectLockedCarts(
				run.cartridgeIds,
				'completeRun',
				runId,
				{ _id: locals.user!._id, username: locals.user!.username }
			);
			await CartridgeRecord.updateMany(
				{
					_id: { $in: run.cartridgeIds },
					status: 'wax_filled',
					'waxStorage.recordedAt': { $exists: true }
				},
				{ $set: { status: 'wax_stored' } }
			);
		}

		// Best-effort tail: equipment usage log, inventory consumption,
		// lifecycle notifications, audit log. Status is already 'completed'
		// and cartridges are 'wax_stored' — a failure here doesn't undo the
		// run, so log and let the operator see success instead of a 500 on
		// a run that's already done.
		try {

		if (run?.deckId) {
			await Equipment.findByIdAndUpdate(run.deckId, {
				$set: { lastUsed: now },
				$push: {
					usageLog: {
						_id: generateId(), usageType: 'run_complete', runId: run._id,
						quantityChanged: cartridgeCount, operator: operatorRef,
						notes: `Wax filling run complete — ${cartridgeCount} cartridges filled`, createdAt: now
					}
				}
			});
		}

		// Deduct 1 unit from the 2ml tube ReceivingLot (and from the part's inventoryCount via recordTransaction)
		// run.waxTubeId now stores the scanned ReceivingLot.lotId (2ml tube lot barcode)
		if (run?.waxTubeId) {
			const tubeLot = await ReceivingLot.findOne({ lotId: run.waxTubeId }).lean() as any;
			if (tubeLot) {
				await ReceivingLot.updateOne(
					{ _id: tubeLot._id },
					{ $inc: { quantity: -1 } }
				);
				if (tubeLot.part?._id) {
					await recordTransaction({
						transactionType: 'consumption',
						partDefinitionId: tubeLot.part._id,
						lotId: tubeLot._id,
						quantity: 1,
						manufacturingStep: 'wax_filling',
						manufacturingRunId: run._id,
						operatorId: locals.user._id,
						operatorUsername: locals.user.username,
						notes: `Wax filling run — 2ml incubator tube consumed (lot ${run.waxTubeId})`
					});
				}
			} else {
				// Legacy path: still support existing Consumable-based tube IDs
				await Consumable.findByIdAndUpdate(run.waxTubeId, {
					$set: { lastUsedAt: now },
					$inc: { totalCartridgesFilled: cartridgeCount, totalRunsUsed: 1 },
					$push: {
						usageLog: {
							_id: generateId(), usageType: 'wax_run', runId: run._id,
							quantityChanged: cartridgeCount, operator: operatorRef,
							notes: `Wax filling run complete — ${cartridgeCount} cartridges`, createdAt: now
						}
					}
				});
			}
		}

		// Deduct the run's computed fill volume from the wax source lot.
		// run.waxSourceLot is the selected ReceivingLot / WaxBatch barcode.
		// consumedUl tracks partial consumption; whole tubes are deducted from
		// quantity (and part inventory via recordTransaction) once each 12000 μL
		// crosses a tube boundary.
		const FULL_TUBE_VOLUME_UL = 12000;
		const runFillVolumeUl = Number(run?.fillVolumeUl ?? LEGACY_WAX_FILL_VOLUME_UL);
		if (run?.waxSourceLot) {
			const waxLot = await ReceivingLot.findOne({
				$or: [
					{ lotId: run.waxSourceLot },
					{ bagBarcode: run.waxSourceLot },
					{ lotNumber: run.waxSourceLot }
				]
			}).lean() as any;
			if (waxLot) {
				const consumedBefore = Number(waxLot.consumedUl ?? 0);
				const capUl = Number(waxLot.quantity ?? 0) * FULL_TUBE_VOLUME_UL;
				const consumedAfter = Math.min(capUl, consumedBefore + runFillVolumeUl);
				const tubesBefore = Math.floor(consumedBefore / FULL_TUBE_VOLUME_UL);
				const tubesAfter = Math.floor(consumedAfter / FULL_TUBE_VOLUME_UL);
				const tubesToDeduct = tubesAfter - tubesBefore;

				const update: Record<string, unknown> = { $set: { consumedUl: consumedAfter } };
				if (tubesToDeduct > 0) update.$inc = { quantity: -tubesToDeduct };
				await ReceivingLot.updateOne({ _id: waxLot._id }, update);

				if (tubesToDeduct > 0 && waxLot.part?._id) {
					await recordTransaction({
						transactionType: 'consumption',
						partDefinitionId: waxLot.part._id,
						lotId: waxLot._id,
						quantity: tubesToDeduct,
						manufacturingStep: 'wax_filling',
						manufacturingRunId: run._id,
						operatorId: locals.user!._id,
						operatorUsername: locals.user!.username,
						notes: `Wax filling — ${tubesToDeduct} × 15ml wax tube consumed (lot ${run.waxSourceLot})`
					});
				}
			}

			// Decrement the in-house WaxBatch volume tracker (parallel to the
			// ReceivingLot update above). WaxBatch is created by wax-creation
			// and is the source Ask BIMS / daily-digest read for remaining
			// wax volumes — without this decrement, those surfaces drift and
			// always show 100% remaining no matter how many runs ship. Match
			// against both lotBarcode (scannable label) and lotNumber
			// (WAX-YYYY-NNNN) since either may have been the scanned value.
			// Runs that scanned a ReceivingLot-only barcode won't match here
			// and the block is a no-op.
			const waxBatch = await WaxBatch.findOne({
				$or: [
					{ lotBarcode: run.waxSourceLot },
					{ lotNumber: run.waxSourceLot }
				]
			}).select('_id remainingVolumeUl').lean() as any;
			if (waxBatch) {
				const remainingBefore = Number(waxBatch.remainingVolumeUl ?? 0);
				const remainingAfter = Math.max(0, remainingBefore - runFillVolumeUl);
				await WaxBatch.updateOne(
					{ _id: waxBatch._id },
					{
						$set: { remainingVolumeUl: remainingAfter },
						$push: {
							usageLog: {
								_id: generateId(),
								runId,
								volumeChangedUl: -(remainingBefore - remainingAfter),
								remainingBeforeUl: remainingBefore,
								remainingAfterUl: remainingAfter,
								operator: operatorRef,
								notes: `Wax filling run complete — ${cartridgeCount} cartridges`,
								createdAt: now
							}
						}
					}
				);
			}
		}

		// Notify run complete
		await notifyRunLifecycle({
			runId,
			runType: 'wax_filling',
			status: 'completed',
			operator: locals.user?.username,
			cartridgeCount,
			robot: run?.robot?.name ?? run?.robot?._id
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { status: 'completed', cartridgeCount }
		});

		} catch (e) {
			console.error('[completeRun] post-update side-effect failed:', e instanceof Error ? e.message : e);
		}

		return { success: true };
	}
};
