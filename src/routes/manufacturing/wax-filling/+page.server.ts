import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, WaxFillingRun, CartridgeRecord, Consumable, ManufacturingSettings, generateId,
	Equipment, EquipmentLocation, AuditLog, BackingLot, WaxBatch, ReceivingLot, LotRecord
} from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import { isAdmin } from '$lib/server/permissions';
import { User } from '$lib/server/db';
import { notifyLowWaxBatch, notifyRunLifecycle, shouldWarnLowWax } from '$lib/server/notifications';
import { checkRobotConflict, checkDeckConflict, checkTrayConflict } from '$lib/server/manufacturing/resource-locks';
import bcrypt from 'bcryptjs';
import type { PageServerLoad, Actions } from './$types';

const WAX_FILL_VOLUME_UL = 800; // μL deducted from the 15ml WaxBatch per run

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
		setup: 'Setup', Setup: 'Setup',
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
		loadError,
		robotBlocked: null as { process: 'reagent'; runId: string | null } | null,
		runState: {
			hasActiveRun: false, runId: null, stage: null,
			runStartTime: null, runEndTime: null,
			deckId: null, waxSourceLot: null, coolingTrayId: null, plannedCartridgeCount: null
		},
		settings: {
			runDurationMin: 45, removeDeckWarningMin: 5, coolingWarningMin: 7,
			deckLockoutMin: 25, incubatorTempC: 37, heaterTempC: 65
		},
		tubeData: null as null | {
			tubeId: string; initialVolumeUl: number; remainingVolumeUl: number;
			status: string; totalCartridgesFilled: number; totalRunsUsed: number;
		},
		activeLotId: null as string | null,
		activeLotCartridgeCount: null as number | null,
		ovenLots: [] as { lotId: string; ready: boolean; cartridgeCount: number }[],
		rejectionCodes: [] as any[],
		qcCartridges: [] as any[],
		storageCartridges: [] as any[],
		fridges: [] as { id: string; displayName: string; barcode: string }[]
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
		const [activeWaxRun, settingsDoc, activeTube, activeReagentRunRaw] = await Promise.all([
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
			}).lean().catch(() => null)
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
				coolingConfirmedAt: run.coolingConfirmedTime ? new Date(run.coolingConfirmedTime).toISOString() : null
			}
			: { hasActiveRun: false, runId: null, stage: null, runStartTime: null, runEndTime: null, deckRemovedTime: null, deckId: null, waxSourceLot: null, coolingTrayId: null, plannedCartridgeCount: null, coolingConfirmedAt: null };

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

		const storageCartridges = (storageCartridgesRaw as any[]).map((c: any) => ({
			cartridgeId: String(c._id),
			qcStatus: c.waxQc?.status ?? 'Accepted',
			currentInventory: c.status ?? 'wax_stored',
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

		// Backing lots from BackingLot collection
		const minOvenTimeMin = wax.minOvenTimeMin ?? 60;
		const now = Date.now();
		const backingLotsRaw = await BackingLot.find({ status: { $in: ['in_oven', 'ready', 'created'] } })
			.sort({ ovenEntryTime: -1 }).lean().catch(() => []);

		const ovenLots = (backingLotsRaw as any[]).map((bl: any) => {
			const entryTime = bl.ovenEntryTime ? new Date(bl.ovenEntryTime).getTime() : 0;
			const elapsedMin = entryTime ? (now - entryTime) / 60000 : 0;
			const remainingMin = Math.max(0, Math.ceil(minOvenTimeMin - elapsedMin));
			return {
				lotId: String(bl._id),
				ready: elapsedMin >= minOvenTimeMin,
				cartridgeCount: bl.cartridgeCount ?? 0,
				ovenName: bl.ovenLocationName ?? '',
				ovenId: bl.ovenLocationId ?? '',
				elapsedMin: Math.floor(elapsedMin),
				remainingMin,
				ovenEntryTime: bl.ovenEntryTime ? new Date(bl.ovenEntryTime).toISOString() : null
			};
		});

		// activeLotId: the current lot associated with the active run (stored on run)
		const activeLotId: string | null = run?.activeLotId ?? null;
		const activeLot = activeLotId ? ovenLots.find((l) => l.lotId === activeLotId) : null;

		// Check if robot is blocked by reagent filling
		const robotBlocked = activeReagentRunRaw
			? { process: 'reagent' as const, runId: activeReagentRunRaw._id ? String(activeReagentRunRaw._id) : null }
			: null;

		return {
			robotId,
			loadError: null,
			robotBlocked,
			runState,
			settings: {
				runDurationMin: wax.runDurationMin ?? 45,
				removeDeckWarningMin: wax.removeDeckWarningMin ?? 5,
				coolingWarningMin: wax.coolingWarningMin ?? 7,
				deckLockoutMin: wax.deckLockoutMin ?? 25,
				incubatorTempC: wax.incubatorTempC ?? 37,
				heaterTempC: wax.heaterTempC ?? 65
			},
			tubeData,
			activeLotId,
			activeLotCartridgeCount: activeLot?.cartridgeCount ?? null,
			ovenLots,
			rejectionCodes,
			qcCartridges,
			storageCartridges,
			fridges,
			minOvenTimeMin
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
	/** Scan backing lot barcode — validates oven time and associates lot with run */
	scanBackingLot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotBarcode = (data.get('lotBarcode') as string)?.trim();
		const runId = (data.get('runId') as string)?.trim();
		const override = data.get('override') === 'true';
		const adminUser = (data.get('adminUser') as string)?.trim() ?? '';
		const adminPass = (data.get('adminPass') as string) ?? '';

		if (!lotBarcode) return fail(400, { error: 'Lot barcode is required' });

		const settingsDoc = await ManufacturingSettings.findById('default').lean() as any;
		const minOvenTimeMin: number = settingsDoc?.waxFilling?.minOvenTimeMin ?? 60;

		const lot = await BackingLot.findById(lotBarcode).lean() as any;
		if (!lot) {
			return fail(404, { error: `Lot "${lotBarcode}" not found. Register it on the manufacturing dashboard first.` });
		}
		if (lot.status === 'consumed') {
			return fail(400, { error: `Lot "${lotBarcode}" has already been consumed.` });
		}

		const entryTime = lot.ovenEntryTime ? new Date(lot.ovenEntryTime).getTime() : 0;
		if (!entryTime) {
			return fail(400, { error: `Lot "${lotBarcode}" has no oven entry time recorded.` });
		}

		const elapsedMin = (Date.now() - entryTime) / 60000;
		const remainingMin = Math.ceil(Math.max(0, minOvenTimeMin - elapsedMin));

		// Admin override path — requires re-auth (username + password). Any
		// admin (permission `admin:full` or `admin:users`) can override; the
		// event is recorded in audit_logs for traceability.
		if (override) {
			const verified = await verifyAdminOverride(adminUser, adminPass);
			if (!verified.ok) {
				return fail(403, { error: verified.error, remainingMin, lotId: lotBarcode, requiresOverride: true });
			}
			await BackingLot.findByIdAndUpdate(lotBarcode, { $set: { status: 'ready' } });
			if (runId) {
				await WaxFillingRun.findByIdAndUpdate(runId, { $set: { activeLotId: lotBarcode } });
			}
			await AuditLog.create({
				_id: generateId(),
				tableName: 'backing_lots',
				recordId: lotBarcode,
				action: 'UPDATE',
				changedBy: verified.user.username,
				changedAt: new Date(),
				reason: `Wax cure time override by admin — ${remainingMin} min remaining`,
				newData: {
					override: true,
					operatorUsername: locals.user.username,
					adminUsername: verified.user.username,
					minOvenTimeMin,
					elapsedMin: Math.floor(elapsedMin),
					remainingMin
				}
			});
			return {
				success: true,
				lotId: lotBarcode,
				cartridgeCount: lot.cartridgeCount ?? 0,
				elapsedMin: Math.floor(elapsedMin),
				overridden: true,
				overrideBy: verified.user.username
			};
		}

		if (elapsedMin < minOvenTimeMin) {
			return fail(400, {
				error: `Lot not ready. ${remainingMin} minute${remainingMin === 1 ? '' : 's'} remaining (minimum ${minOvenTimeMin} min required). Wait, pick a bucket that has passed the timer, or get an admin to override.`,
				remainingMin,
				lotId: lotBarcode,
				requiresOverride: true
			});
		}

		// Mark lot as ready in DB
		await BackingLot.findByIdAndUpdate(lotBarcode, { $set: { status: 'ready' } });

		// If a runId was provided, record activeLotId on the run
		if (runId) {
			await WaxFillingRun.findByIdAndUpdate(runId, {
				$set: { activeLotId: lotBarcode }
			});
		}

		return {
			success: true,
			lotId: lotBarcode,
			cartridgeCount: lot.cartridgeCount ?? 0,
			elapsedMin: Math.floor(elapsedMin)
		};
	},

	/** Create a new wax filling run in Setup status */
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
			operator: { _id: locals.user._id, username: locals.user.username },
			status: 'Setup',
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

	/** Confirm setup — transition existing run from Setup to Loading */
	confirmSetup: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		if (!runId) return fail(400, { error: 'Run ID required' });

		const run = await WaxFillingRun.findById(runId).lean() as any;
		if (!run) return fail(400, { error: 'Run not found' });
		if (run.status !== 'Setup' && run.status !== 'setup') {
			return fail(400, { error: `Run is not in Setup status (current: ${run.status})` });
		}

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'Loading', updatedAt: new Date() }
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: new Date(),
			newData: { status: 'Loading' }
		});

		return { success: true, runId };
	},

	/** Record wax preparation (tube info) */
	recordWaxPrep: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const waxTubeId = (data.get('waxTubeId') as string) || undefined;
		const waxSourceLot = (data.get('waxSourceLot') as string) || undefined;
		const plannedCartridgeCount = data.get('plannedCartridgeCount') ? Number(data.get('plannedCartridgeCount')) : undefined;

		const update: Record<string, any> = { status: 'Loading' };
		if (waxTubeId) update.waxTubeId = waxTubeId;
		if (waxSourceLot) update.waxSourceLot = waxSourceLot;
		if (plannedCartridgeCount) update.plannedCartridgeCount = plannedCartridgeCount;

		await WaxFillingRun.findByIdAndUpdate(runId, { $set: update });
		return { success: true };
	},

	/** Load deck — add cartridges to run */
	loadDeck: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const deckId = (data.get('deckId') as string) || undefined;
		const ovenId = (data.get('ovenId') as string) || undefined;
		const cartridgeScansRaw = data.get('cartridgeScans') as string;

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

		// Check if any of these cartridges are already in another active wax run
		if (cartridgeIds.length > 0) {
			const alreadyInUse = await CartridgeRecord.find({
				_id: { $in: cartridgeIds },
				'waxFilling.runId': { $exists: true },
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

		// Get activeLotId from the run for traceability
		const activeLotId: string | undefined = (run as any).activeLotId ?? undefined;

		// Resolve the parent LotRecord so we can copy the raw-material lineage
		// (cartridge blank / thermoseal / barcode-label input lot barcodes, plus
		// the QR ref and oven placement recorded at WI-01) onto each scanned
		// cartridge. This is the point at which a physical cartridge barcode
		// becomes an individual CartridgeRecord — WI-01 only tracks the aggregate
		// BackingLot up to this moment.
		const parentLot = activeLotId
			? await LotRecord.findOne({ bucketBarcode: activeLotId }).lean() as any
			: null;
		const backingInputLots = (parentLot?.inputLots ?? []) as Array<any>;
		const backingInputLotByMaterial: Record<string, string | null> = {
			cartridgeBlankLot: backingInputLots.find((l) => l.materialName === 'Cartridge')?.barcode ?? null,
			thermosealLot: backingInputLots.find((l) => l.materialName === 'Thermoseal Laser Cut Sheet')?.barcode ?? null,
			barcodeLabelLot: backingInputLots.find((l) => l.materialName === 'Barcode')?.barcode ?? null
		};

		// Create CartridgeRecord stubs and link to this wax run.
		// Also record baking oven exit: cartridges are leaving the baking oven
		// (where they were placed during WI-01) and going onto the deck.
		if (cartridgeIds.length > 0) {
			const now = new Date();

			// Decrement FIRST with a conditional that refuses to over-pull.
			// If the bucket doesn't have enough cartridges left, fail the whole
			// loadDeck before we create any CartridgeRecord rows. This closes the
			// race where two concurrent loadDecks could each pull past zero, and
			// the gap where an operator scans more cartridges than the bucket
			// holds — see the 2941bb67 incident (54-cart lot, 66 pulled).
			if (activeLotId) {
				const updatedLot = await BackingLot.findOneAndUpdate(
					{ _id: activeLotId, cartridgeCount: { $gte: cartridgeIds.length } },
					{ $inc: { cartridgeCount: -cartridgeIds.length } },
					{ new: true }
				).lean() as any;
				if (!updatedLot) {
					const current = await BackingLot.findById(activeLotId).select('cartridgeCount status').lean() as any;
					return fail(400, {
						error: `Backing lot ${activeLotId} has only ${current?.cartridgeCount ?? 0} cartridge(s) remaining (status=${current?.status ?? 'unknown'}) but ${cartridgeIds.length} were scanned. Load fewer cartridges or scan a different lot.`
					});
				}
				if ((updatedLot.cartridgeCount ?? 0) <= 0) {
					await BackingLot.findByIdAndUpdate(activeLotId, {
						$set: { cartridgeCount: 0, status: 'consumed' }
					});
				}
			}

			// Lineage filters: the new backing.* fields are written only when
			// they aren't already populated (so a re-scan of an existing cart
			// after abort/rescan still gets its lineage stamped, but we don't
			// stomp an existing record's lineage with a different lot).
			const ops = cartridgeIds.map((cid: string, idx: number) => ({
				updateOne: {
					filter: { _id: cid },
					update: {
						$setOnInsert: {
							_id: cid,
							'backing.operator': { _id: locals.user._id, username: locals.user.username },
							'backing.recordedAt': now
						},
						$set: {
							status: 'wax_filling',
							'backing.lotId': activeLotId ?? null,
							// Record baking oven exit — cartridge is leaving the baking oven
							'backing.ovenExitTime': now,
							// Material lineage copied from the parent LotRecord. Using
							// $set (not $setOnInsert) so a re-scan after abort still
							// writes them. loadDeck already rejects cartridges that
							// finished another wax run, so this can't clobber finished
							// work.
							'backing.lotQrCode': parentLot?.qrCodeRef ?? null,
							'backing.ovenEntryTime': parentLot?.ovenEntryTime ?? null,
							'backing.cartridgeBlankLot': backingInputLotByMaterial.cartridgeBlankLot,
							'backing.thermosealLot': backingInputLotByMaterial.thermosealLot,
							'backing.barcodeLabelLot': backingInputLotByMaterial.barcodeLabelLot,
							'backing.parentLotRecordId': parentLot?._id ?? null,
							'waxFilling.runId': runId,
							'waxFilling.deckId': deckId ?? null,
							'waxFilling.robotId': run.robot?._id ?? null,
							'waxFilling.robotName': run.robot?.name ?? null,
							'waxFilling.deckPosition': idx + 1,
							'waxFilling.operator': { _id: locals.user._id, username: locals.user.username }
						}
					},
					upsert: true
				}
			}));
			try {
				await CartridgeRecord.bulkWrite(ops);
			} catch (err) {
				console.error('[loadDeck] bulkWrite error:', err instanceof Error ? err.message : err);
				// Roll back the BackingLot decrement so the bucket isn't silently
				// drained by a failed load.
				if (activeLotId) {
					await BackingLot.findByIdAndUpdate(activeLotId, {
						$inc: { cartridgeCount: cartridgeIds.length }
					}).catch(() => {});
				}
				return fail(500, { error: `Failed to save cartridge records: ${err instanceof Error ? err.message : 'Unknown error'}` });
			}
		}

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: {
				status: 'Loading',
				deckId: deckId ?? run.deckId,
				ovenId: ovenId ?? run.ovenId,
				plannedCartridgeCount: cartridgeIds.length || run.plannedCartridgeCount
			},
			$addToSet: { cartridgeIds: { $each: cartridgeIds } }
		});

		return { success: true };
	},

	/** Start the robot run */
	startRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const now = new Date();

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'Running', runStartTime: now }
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { status: 'Running' }
		});

		return { success: true };
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

		const update: Record<string, any> = { status: 'QC', coolingConfirmedTime: now, coolingConfirmedAt: now };
		if (coolingTrayId) update.coolingTrayId = coolingTrayId;

		const run = await WaxFillingRun.findByIdAndUpdate(runId, { $set: update }, { new: true }).lean() as any;

		// Record oven exit time on cartridges that have an ovenCure.entryTime
		if (run?.cartridgeIds?.length) {
			const bulkOps = run.cartridgeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'ovenCure.entryTime': { $exists: true }, 'ovenCure.exitTime': { $exists: false } },
					update: { $set: { 'ovenCure.exitTime': now } }
				}
			}));
			await CartridgeRecord.bulkWrite(bulkOps);
		}

		return { success: true };
	},

	/** Complete QC — inspect all cartridges and transition to Storage */
	completeQC: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const now = new Date();

		// Server-side cooling timer check: minimum 10 minutes must pass after cooling confirmed
		const runBeforeQc = await WaxFillingRun.findById(runId).select('coolingConfirmedAt').lean() as any;
		if (runBeforeQc?.coolingConfirmedAt) {
			const elapsedMs = Date.now() - new Date(runBeforeQc.coolingConfirmedAt).getTime();
			if (elapsedMs < 10 * 60 * 1000) {
				const remainingMin = Math.ceil((10 * 60 * 1000 - elapsedMs) / 60000);
				return fail(400, { error: `Cartridges must cool for at least 10 minutes before QC inspection. ${remainingMin} minute${remainingMin === 1 ? '' : 's'} remaining.` });
			}
		}

		const run = await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'Storage', runEndTime: now }
		}, { new: true }).lean() as any;

		// Write waxFilling phase to all cartridges (WRITE-ONCE)
		if (run?.cartridgeIds?.length) {
			const bulkOps = run.cartridgeIds.map((cid: string) => ({
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
			const acceptOps = run.cartridgeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'waxQc.recordedAt': { $exists: false }, status: { $ne: 'scrapped' } },
					update: {
						$set: {
							'waxQc.status': 'Accepted',
							'waxQc.operator': { _id: locals.user._id, username: locals.user.username },
							'waxQc.timestamp': now,
							'waxQc.recordedAt': now
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(acceptOps);

			// Record inventory transactions for each cartridge — consume wax (PT-CT-105)
			const waxPartId = await resolvePartId('PT-CT-105');
			for (const cid of run.cartridgeIds) {
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
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { status: 'Storage' }
		});

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

		// Look up the run so we know which BackingLot to restore + how many to refund
		const runBeforeCancel = await WaxFillingRun.findById(runId).select('activeLotId cartridgeIds').lean() as any;
		const cancelRefundLotId: string | undefined = runBeforeCancel?.activeLotId ?? undefined;
		const cancelScannedIds: string[] = (runBeforeCancel?.cartridgeIds ?? []) as string[];

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'aborted', abortReason: reason, runEndTime: now }
		});

		// Cartridges scanned onto the deck never actually got wax-filled. Delete
		// the CartridgeRecords so the same physical barcodes can be re-scanned
		// on a future run. status='backing' is not a valid CartridgeRecord state
		// post-WI-01-refactor (cartridges only individuate on wax scan).
		if (cancelScannedIds.length > 0) {
			await CartridgeRecord.deleteMany({
				_id: { $in: cancelScannedIds },
				'waxFilling.runId': runId,
				status: 'wax_filling'
			});
		}

		// Refund the BackingLot count so the bucket stays available for another run.
		if (cancelRefundLotId && cancelScannedIds.length > 0) {
			await BackingLot.findByIdAndUpdate(cancelRefundLotId, {
				$inc: { cartridgeCount: cancelScannedIds.length },
				$set: { status: 'ready' }
			});
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { status: 'aborted', abortReason: reason, refundedToLot: cancelRefundLotId, refundedCount: cancelScannedIds.length }
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

		// Look up the run so we know which BackingLot to restore + how many to refund
		const runBeforeAbort = await WaxFillingRun.findById(runId).select('activeLotId cartridgeIds').lean() as any;
		const abortRefundLotId: string | undefined = runBeforeAbort?.activeLotId ?? undefined;
		const abortScannedIds: string[] = (runBeforeAbort?.cartridgeIds ?? []) as string[];

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'aborted', abortReason: reason, runEndTime: now }
		});

		// Same refund semantics as cancelRun — see comment there.
		if (abortScannedIds.length > 0) {
			await CartridgeRecord.deleteMany({
				_id: { $in: abortScannedIds },
				'waxFilling.runId': runId,
				status: 'wax_filling'
			});
		}

		if (abortRefundLotId && abortScannedIds.length > 0) {
			await BackingLot.findByIdAndUpdate(abortRefundLotId, {
				$inc: { cartridgeCount: abortScannedIds.length },
				$set: { status: 'ready' }
			});
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { status: 'aborted', abortReason: reason, refundedToLot: abortRefundLotId, refundedCount: abortScannedIds.length }
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

		// Wax rejects use status='scrapped' (distinct from the generic 'voided'
		// used by operator-initiated removals). Cartridge stays in the system
		// so inventory + traceability queries can still find it.
		await CartridgeRecord.findOneAndUpdate(
			{ _id: cartridgeId, 'waxQc.recordedAt': { $exists: false } },
			{
				$set: {
					'waxQc.status': 'Rejected',
					'waxQc.rejectionReason': rejectionReason,
					'waxQc.operator': { _id: locals.user._id, username: locals.user.username },
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

		const now = new Date();
		if (cartridgeIds.length > 0) {
			const bulkOps = cartridgeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'waxStorage.recordedAt': { $exists: false } },
					update: {
						$set: {
							'waxStorage.location': location,
							'waxStorage.coolingTrayId': coolingTrayId,
							'waxStorage.operator': { _id: locals.user._id, username: locals.user.username },
							'waxStorage.timestamp': now,
							'waxStorage.recordedAt': now,
							status: 'wax_stored'
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
					operatorId: locals.user._id,
					operatorUsername: locals.user.username,
					notes: `Wax storage: ${location}${coolingTrayId ? `, tray ${coolingTrayId}` : ''}`
				});
			}

			// Audit log for batch storage
			await AuditLog.create({
				_id: generateId(),
				tableName: 'cartridge_records',
				recordId: cartridgeIds[0] ?? 'batch',
				action: 'UPDATE',
				changedBy: locals.user?.username,
				changedAt: now,
				newData: { status: 'wax_stored', location, count: cartridgeIds.length }
			});
		}

		return { success: true };
	},

	/** Complete the full run */
	completeRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const now = new Date();

		const run = await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'completed', runEndTime: now }
		}, { new: true }).lean() as any;

		// Update consumable usage logs
		const cartridgeCount = run?.cartridgeIds?.length ?? 0;
		const operatorRef = { _id: locals.user._id, username: locals.user.username };

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

		// Deduct 800 μL from the scanned 15ml wax tube ReceivingLot.
		// run.waxSourceLot is the scanned ReceivingLot.lotId / bagBarcode.
		// consumedUl tracks partial consumption; whole tubes are deducted from
		// quantity (and part inventory via recordTransaction) once each 12000 μL
		// crosses a tube boundary.
		const FULL_TUBE_VOLUME_UL = 12000;
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
				const consumedAfter = Math.min(capUl, consumedBefore + WAX_FILL_VOLUME_UL);
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

		return { success: true };
	}
};
