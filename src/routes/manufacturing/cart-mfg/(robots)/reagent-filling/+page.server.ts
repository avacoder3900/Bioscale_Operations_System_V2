import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, ReagentBatchRecord, AssayDefinition, CartridgeRecord, Consumable,
	ManufacturingSettings, WaxFillingRun, Equipment, EquipmentLocation, generateId, AuditLog,
	ReagentLot,
	OpentronsRobot, Ot2BridgeCommand
} from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import { ReagentSetLot, FillLot, fillLotNumber } from '$lib/server/db';

import { findBucketLabels } from '$lib/server/services/bucket-service';
import { checkRobotConflict, checkDeckConflict, checkTrayConflict } from '$lib/server/manufacturing/resource-locks';
import { WAX_PAGE_OWNED } from '$lib/server/manufacturing/run-statuses';
import { getRobot, robotGet, bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';
import { bridgeJobGate } from '$lib/server/opentrons/bridge-token';
import { requirePermission } from '$lib/server/permissions';
import { serializeWellIssues } from '$lib/server/manufacturing/reagent-wizard';
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
import {
	REAGENT_WELL_ISSUE_CODES,
	REAGENT_WELLS,
	type ReagentWellIssueRow
} from '$lib/manufacturing/reagent-well-issues';
import type { PageServerLoad, Actions } from './$types';

// Extend Vercel serverless timeout to 60s
export const config = { maxDuration: 60 };

const TERMINAL = new Set(['completed', 'aborted', 'voided', 'cancelled', 'Completed', 'Aborted', 'Cancelled']);

/**
 * ROBOT-OVERHAUL round 2: the single-robot reagent page is gone — every wizard
 * renders on the Robots page, side by side (loadReagentWizard in
 * $lib/server/manufacturing/reagent-wizard.ts is this route's old load). The
 * actions below stay here; ReagentWizard.svelte posts to them as
 * /manufacturing/cart-mfg/reagent-filling?/<action>&robot=<id>.
 */
export const load: PageServerLoad = async ({ url }) => {
	const robot = url.searchParams.get('robot');
	redirect(302, `/manufacturing/cart-mfg/robots${robot ? `?open=${encodeURIComponent(robot)}:reagent` : ''}`);
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
		const fillLotId = ((data.get('fillLotId') as string | null) ?? '').trim();
		if (!fillLotId) return fail(400, { error: 'A fill lot is required to fill. Open one (pick its reagent lot) and select it.' });
		const fillLot = await FillLot.findById(fillLotId).lean() as any;
		if (!fillLot || !fillLot.fillLotNumber || fillLot.status !== 'open') return fail(400, { error: 'Fill lot not found or closed' });
		const reagentLot = fillLot.reagentLotId ? await ReagentSetLot.findById(fillLot.reagentLotId).lean() as any : null;
		if (!reagentLot || reagentLot.status !== 'active') return fail(400, { error: 'The fill lot\'s reagent lot is missing or retired' });

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
			$set: { tubeRecords, status: 'Loading', fillLotId, fillLotNumber: fillLot.fillLotNumber, reagentLotId: String(reagentLot._id), reagentLotNumber: reagentLot.lotNumber }
		});

		return { success: true };
	},

	/** DOMAIN-32: open a fill lot from the fill screen — a reagent lot plus a name (FL-YYYYMMDD-NNN). */
	createFillLot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const data = await request.formData();
		const reagentLotId = ((data.get('reagentLotId') as string | null) ?? '').trim();
		const name = ((data.get('name') as string | null) ?? '').trim().slice(0, 200);
		if (!reagentLotId) return fail(400, { error: 'Pick a reagent lot' });
		const reagentLot = await ReagentSetLot.findById(reagentLotId).lean() as any;
		if (!reagentLot || reagentLot.status !== 'active') return fail(400, { error: 'Reagent lot not found or retired' });
		const now = new Date();
		const prefix = fillLotNumber(now, 0).slice(0, -3);
		const todays = await FillLot.countDocuments({ fillLotNumber: { $regex: `^${prefix}` } });
		const doc = {
			_id: generateId(),
			fillLotNumber: fillLotNumber(now, todays + 1),
			name,
			status: 'open',
			assayId: reagentLot.assayId ?? '',
			assayName: '',
			fillDate: now.toISOString(),
			runIds: [],
			reagentLotId: String(reagentLot._id),
			reagentLotNumber: reagentLot.lotNumber,
			reagentLotSource: 'bims',
			curveSetId: '', curveSetSource: '', assignedBy: '', assignedAt: '', assignmentNote: '', notes: '',
			createdBy: locals.user.username ?? String(locals.user._id)
		};
		await FillLot.create(doc);
		return { success: true, fillLot: JSON.parse(JSON.stringify(doc)) };
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
	/**
	 * Well tracker (2026-10-06): log one fill mistake the operator just saw, at
	 * a deck position + reagent well. Written straight onto the run so it is
	 * there on reload and for every browser watching the run; copied to the
	 * cartridge at completion (finalizeReagentRun). Allowed while the run is
	 * page-owned (Running, and Loading for a mistake noticed pre-start), not
	 * after Done — post-completion observations belong on Reagent Inspect.
	 */
	logWellIssue: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const runId = data.get('runId')?.toString();
		const deckPosition = Math.floor(Number(data.get('deckPosition')));
		const well = Math.floor(Number(data.get('well')));
		const issue = data.get('issue')?.toString() ?? '';
		const note = (data.get('note')?.toString() ?? '').trim().slice(0, 500);
		if (!runId) return fail(400, { error: 'Missing runId' });
		if (!(deckPosition >= 1 && deckPosition <= 24)) return fail(400, { error: 'Deck position must be 1–24' });
		if (!REAGENT_WELLS.some((w) => w.well === well)) return fail(400, { error: 'Well must be 2, 3, 4 or 5' });
		if (!REAGENT_WELL_ISSUE_CODES.includes(issue)) return fail(400, { error: `Unknown issue "${issue}"` });

		const run = await ReagentBatchRecord.findById(runId)
			.select('status finalizedAt cartridgesFilled tubeRecords assayType').lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });
		if (run.finalizedAt || TERMINAL.has(String(run.status))) {
			return fail(400, { error: 'Run is finished — log post-run observations on Reagent Inspect.' });
		}
		const cart = (run.cartridgesFilled ?? []).find((c: any) => Number(c.deckPosition) === deckPosition);
		const tube = (run.tubeRecords ?? []).find((t: any) => Number(t.wellPosition) === well);
		const reagentName = tube?.reagentName ?? REAGENT_WELLS.find((w) => w.well === well)?.defaultName ?? null;

		const entry = {
			_id: generateId(),
			deckPosition,
			cartridgeId: cart?.cartridgeId ?? null,
			well,
			reagentName,
			issue,
			note: note || undefined,
			loggedBy: { _id: locals.user._id, username: locals.user.username },
			loggedAt: new Date()
		};
		await ReagentBatchRecord.findByIdAndUpdate(runId, { $push: { wellIssues: entry } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'reagent_batch_records',
			recordId: runId,
			action: 'reagent_well_issue_logged',
			changedBy: locals.user.username,
			changedAt: entry.loggedAt,
			newData: { issueId: entry._id, deckPosition, well, issue, note: note || null, cartridgeId: entry.cartridgeId }
		});
		const fresh = await ReagentBatchRecord.findById(runId).select('wellIssues').lean() as any;
		return { success: true, wellIssues: serializeWellIssues(fresh?.wellIssues) };
	},

	/** Well tracker: remove a mis-tapped entry (audited, keeps the old row). */
	removeWellIssue: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const runId = data.get('runId')?.toString();
		const issueId = data.get('issueId')?.toString();
		if (!runId || !issueId) return fail(400, { error: 'Missing runId or issueId' });
		const run = await ReagentBatchRecord.findById(runId).select('status finalizedAt wellIssues').lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });
		if (run.finalizedAt || TERMINAL.has(String(run.status))) {
			return fail(400, { error: 'Run is finished — its well log is locked.' });
		}
		const old = (run.wellIssues ?? []).find((w: any) => String(w._id) === issueId);
		if (!old) return fail(404, { error: 'Entry not found (already removed?)' });
		await ReagentBatchRecord.findByIdAndUpdate(runId, { $pull: { wellIssues: { _id: issueId } } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'reagent_batch_records',
			recordId: runId,
			action: 'reagent_well_issue_removed',
			changedBy: locals.user.username,
			changedAt: new Date(),
			oldData: JSON.parse(JSON.stringify(old))
		});
		const fresh = await ReagentBatchRecord.findById(runId).select('wellIssues').lean() as any;
		return { success: true, wellIssues: serializeWellIssues(fresh?.wellIssues) };
	},

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
					tableName: 'reagent_batch_records',
					recordId: runId,
					action: 'reagent_tip_swap_submit_failed',
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
				tableName: 'reagent_batch_records',
				recordId: runId,
				action: cancel ? 'reagent_tip_swap_cancel' : 'reagent_tip_swap_request',
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
