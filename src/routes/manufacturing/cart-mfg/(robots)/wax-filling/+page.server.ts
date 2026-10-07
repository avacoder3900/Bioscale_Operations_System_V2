import { redirect, fail } from '@sveltejs/kit';

import mongoose from 'mongoose';
import {
	connectDB, WaxFillingRun, CartridgeRecord, Consumable, ManufacturingSettings, generateId,
	Equipment, EquipmentLocation, AuditLog, BackingLot, WaxBatch, ReceivingLot,
	OpentronsRobot, ManualCartridgeRemoval, Ot2BridgeCommand, TipCalibratorFixture
} from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import { findBucketLabels, consumeCarts, BucketError, BACKED_STAGE, BACKED_LABEL } from '$lib/server/services/bucket-service';
import { BucketCycle } from '$lib/server/db';
import { resolveFridgeId, resolveCoolingTrayId, resolveDeckId } from '$lib/server/services/equipment-resolve';
import { isAdmin } from '$lib/server/permissions';
import { User } from '$lib/server/db';
import { notifyLowWaxBatch, notifyRunLifecycle, shouldWarnLowWax } from '$lib/server/notifications';
import { checkRobotConflict, checkDeckConflict, checkTrayConflict } from '$lib/server/manufacturing/resource-locks';
import { protectLockedCarts, LOCKED_STATUSES } from '$lib/server/manufacturing/locked-cartridges';
import { getRobot, robotGet, bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';
import { bridgeJobGate } from '$lib/server/opentrons/bridge-token';
import { requirePermission } from '$lib/server/permissions';
import { WAX_TUBE_PART_NUMBER } from '$lib/server/manufacturing/wax-wizard';
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

/**
 * ROBOT-OVERHAUL round 2: the single-robot wax page is gone — every wizard
 * renders on the Robots page, side by side (loadWaxWizard in
 * $lib/server/manufacturing/wax-wizard.ts is this route's old load). The
 * actions below stay here; WaxWizard.svelte posts to them as
 * /manufacturing/cart-mfg/wax-filling?/<action>&robot=<id>.
 */
export const load: PageServerLoad = async ({ url }) => {
	const robot = url.searchParams.get('robot');
	redirect(302, `/manufacturing/cart-mfg/robots${robot ? `?open=${encodeURIComponent(robot)}:wax` : ''}`);
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

		// Cartridges arrive here at status 'backing' ("Backed"),
		// still sitting in their production bucket. loadDeck validates each scan
		// against those records and then draws the members out of their bucket
		// pass (consumeCarts) — the deck load IS the handoff since 2026-09-25.
		// Backing-oven tracking and the cure-time gate were removed app-wide
		// (2026-09-23) — nothing here reads oven entry time any more.
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
								'backing.recordedAt': now,
								'backing.synthetic': true // test-mode only; cancel/abort hard-deletes these
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
				return fail(400, { error: `Cartridge(s) not found: ${missing.join(', ')}. A cart exists once it is scanned into a production bucket; advance its bucket to "${BACKED_LABEL}" on the bucket board first.` });
			}
			if (wrongStatus.length > 0) {
				return fail(400, { error: `Cartridge(s) not available for wax filling: ${wrongStatus.map((w) => `${w.id} (${w.status})`).join(', ')}. Only carts in a "${BACKED_LABEL}" bucket (status backing) can be loaded.` });
			}

			// Draw the members out of their backed bucket pass. Carts that are not in
			// any open pass (legacy WI-01 draws, overrides, returns to a busy tub) are
			// loose and load without a bucket write. Done BEFORE the status write so a
			// bucket refusal leaves the cart untouched; if the status write fails after
			// this, the cart is merely loose at 'backing' and still loadable.
			const memberCycles = await BucketCycle.find({ status: 'open', cartridgeIds: { $in: cartridgeIds } })
				.select('_id bucketId cycleNumber stage cartridgeIds').lean() as any[];
			const scanSet = new Set(cartridgeIds);
			for (const cyc of memberCycles) {
				const members = (cyc.cartridgeIds as string[]).filter((id) => scanSet.has(id));
				if (members.length === 0) continue;
				try {
					await consumeCarts({ cycleId: String(cyc._id), barcodes: members, waxRunId: runId, user: { _id: locals.user._id, username: locals.user.username } });
				} catch (e) {
					if (e instanceof BucketError) return fail(e.status, { error: `Bucket ${cyc.bucketId} #${cyc.cycleNumber}: ${e.message}` });
					throw e;
				}
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
