/**
 * The BIMS halves of the fill-page run lifecycle (OT2-TAILNET-5 §7.1).
 *
 * Every lifecycle action is "server prepare → robot half → server confirm":
 *
 *   robot half   shared verbs in $lib/opentrons/ot2-protocol (run.ensureFresh,
 *                run.uploadProtocol, run.create, run.action, run.stop,
 *                run.commands) and the sequences that order them
 *   BIMS halves  here — TODAY's code from the wax / reagent +page.server.ts,
 *                split at the robot calls (moved, not rewritten)
 *
 *   queue line   the page's single action (startRun, recordRunFinished,
 *                cancelRun, abortRun) runs prepare → runVerb(serverTransport)
 *                → confirm in one server call: same robot requests, same records
 *   tailnet line the browser runs the robot half over the session and calls
 *                the ?/…Prepare / ?/…Confirm actions, which reach these same
 *                functions; only robot OBSERVATIONS come from the browser
 *                (run id, final status, parsed tips / wells), re-validated here
 *
 * Every AuditLog row the old code wrote is still written, with newData.line.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB,
	AuditLog,
	generateId,
	WaxFillingRun,
	ReagentBatchRecord,
	CartridgeRecord,
	Equipment,
	ManufacturingSettings,
	Ot2BridgeCommand,
	OpentronsRunRecord
} from '$lib/server/db';
import {
	runVerb,
	startRunSequence,
	observeRunFinished,
	observeRunStopped,
	cartsFilledFromWells,
	isStepError,
	FILLED_WELL_RE,
	validUploadedResult,
	type FinishObservation,
	type StopObservation,
	type StartConfirmObs,
	type StartPrepared,
	type StartRunSteps,
	type SequenceVerb,
	type UploadedProtocolResult,
	type ProtocolUploadBundle,
	type ProcessType,
	type Line,
	type StepError
} from '$lib/opentrons/ot2-protocol';
import { getRobot, bridgeDeviceIdForRobot } from './proxy';
import { serverTransport } from './transport';
import { calibrationRtpValues } from './calibration-rtps';
import {
	currentProtocolEntry,
	loadExpectedWells,
	resyncBundle,
	recordResyncUpload,
	auditResync,
	storedRunProtocol
} from './protocol-freshness';
import { resolveDeckBinding, DeckBindingError } from '$lib/server/services/deck-calibration/run-guard';
import { isHardenedRobot } from '$lib/server/services/deck-calibration/rollout';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import { protectLockedCarts } from '$lib/server/manufacturing/locked-cartridges';
import { hardDeleteUnfinalizedCartridges } from '$lib/server/services/cartridge-hard-delete';
import { notifyRunLifecycle } from '$lib/server/notifications';
import { estimateReagentRunSeconds } from '$lib/manufacturing/reagent-run-estimate';

export type FillKind = 'wax' | 'reagent';
export type { Line };
type User = { _id: string; username: string };
/** A form-action failure: the page action returns fail(status, { error }). */
export type ActionFail = { fail: { status: number; error: string; [k: string]: unknown } };
const actionFail = (status: number, error: string, extra: Record<string, unknown> = {}): ActionFail => ({ fail: { status, error, ...extra } });
export const isActionFail = (v: unknown): v is ActionFail => !!v && typeof v === 'object' && 'fail' in (v as any);

const K = {
	wax: {
		processType: 'wax-filling' as ProcessType,
		table: 'wax_filling_runs',
		notFound: 'Wax filling run not found',
		noRobot: 'Wax run has no robot assigned',
		noOtRun: 'This wax run has no OT-2 run linked',
		log: 'wax-filling'
	},
	reagent: {
		processType: 'reagent-filling' as ProcessType,
		table: 'reagent_batch_records',
		notFound: 'Reagent run not found',
		noRobot: 'Reagent run has no robot assigned',
		noOtRun: 'This reagent run has no OT-2 run linked',
		log: 'reagent-filling'
	}
};
const model = (kind: FillKind): any => (kind === 'wax' ? WaxFillingRun : ReagentBatchRecord);

/** Minutes after which an unresolved start intent is shown as interrupted. */
export const START_INTENT_BANNER_MS = 10 * 60_000;
/**
 * An intent with no robot run is only cleared once no start can still be in
 * flight. The longest start is a stale re-sync: freshness check + upload (110 s)
 * + verify (up to 120 s) + create — about 5 min — so allow 8.
 */
export const START_INTENT_CLEAR_MS = 8 * 60_000;
/** A create whose answer was lost is ruled out once the robot lists no such run this long after. */
export const START_INTENT_UNCERTAIN_CLEAR_MS = 15_000;
export const START_INTERRUPTED_BANNER = 'start interrupted — check robot';

// ── validation of browser-reported robot observations ──────────────────────

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
export function validRunId(v: unknown): v is string {
	return typeof v === 'string' && RUN_ID_RE.test(v);
}
/** Lower-cased final status; '' when absent. Anything else odd → null (reject). */
export function validFinalStatus(v: unknown): string | null {
	const s = String(v ?? '').toLowerCase();
	return s === '' || /^[a-z_-]{1,40}$/.test(s) ? s : null;
}
export function validTips(v: unknown): FinishObservation['tips'] | null {
	const t = v as any;
	if (!t || typeof t !== 'object') return null;
	const idx = t.nextTipIndex;
	const n = t.pickUpTipCount;
	if (!(idx === null || (Number.isInteger(idx) && idx >= 0 && idx < 100_000))) return null;
	if (!(Number.isInteger(n) && n >= 0 && n < 100_000)) return null;
	return { nextTipIndex: idx, pickUpTipCount: n };
}
export function validFilledWells(v: unknown): string[] | null | undefined {
	if (v === null) return null;
	if (!Array.isArray(v) || v.length > 1000) return undefined;
	// A real deck well: rows A–X, columns 1–24 (the 384-well geometry the wax deck uses).
	const wellOk = (w: unknown) => {
		if (typeof w !== 'string') return false;
		const m = FILLED_WELL_RE.exec(w);
		const col = m ? parseInt(m[2], 10) : 0;
		return col >= 1 && col <= 24;
	};
	return v.every(wellOk) ? (v as string[]) : undefined;
}
export function validStopWarning(v: unknown): string | null | undefined {
	if (v === null || v === undefined || v === '') return null;
	return typeof v === 'string' && v.length <= 1000 ? v : undefined;
}
export function validLine(v: unknown): Line {
	return v === 'tailnet' ? 'tailnet' : 'queue';
}

// ── shared record writers (moved from the page servers) ────────────────────

/**
 * Flip a run's carts wax_filling → wax_filled with the full waxFilling phase
 * stamp + PT-CT-105 consumption. Shared by: auto-advance on a clean run
 * completion, the smart abort (advance only the carts the robot actually
 * finished), and the load reconcile.
 * Returns { advanced, skipped } — skipped = locked carts or carts whose status
 * was no longer wax_filling.
 */
export async function advanceCartsToWaxFilled(
	run: any,
	cartIds: string[],
	user: User,
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
	} catch {
		/* non-fatal */
	}
	return { advanced, skipped };
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
export const PRE_REAGENT_STATUSES = ['backing', 'wax_filled', 'wax_qc', 'wax_ready', 'wax_stored'];

/**
 * Finalize a reagent run (REAGENT-TOPSEAL-IMPLICIT): run → Completed, robot
 * released, cartridges stamped reagent_filled, tube + top-seal inventory
 * consumed. Idempotent — callable from recordRunFinished (auto, the moment
 * the .py succeeds), the load-time reconcile, and the manual Complete button.
 */
export async function finalizeReagentRun(runId: string, user: User, trigger: string): Promise<{ ok: true } | { notFound: true }> {
	const now = new Date();

	// Idempotency: auto-complete, load reconcile, and the button can race.
	const existing = (await ReagentBatchRecord.findById(runId).select('status finalizedAt').lean()) as any;
	if (!existing) return { notFound: true };
	if (existing.status === 'Completed' || existing.finalizedAt) return { ok: true };

	const run = (await ReagentBatchRecord.findByIdAndUpdate(
		runId,
		{
			$set: {
				status: 'Completed',
				finalizedAt: now,
				runEndTime: now,
				// Robot is physically free as of now — releases the robot lock so
				// the next wax/reagent run can start.
				robotReleasedAt: now
			}
		},
		{ new: true }
	).lean()) as any;

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
			const settingsDoc = (await ManufacturingSettings.findById('default').lean().catch(() => null)) as any;
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
					usageType: 'run_complete',
					runId: run._id,
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

const TERMINAL_RECORD = ['succeeded', 'failed', 'stopped', 'error'];

/**
 * S8: the linked OpentronsRunRecord follows the run to its terminal status here,
 * in the lifecycle confirms (the in-memory health poller used to do it).
 */
export async function setRunRecordStatus(
	manufacturingRunId: string,
	opentronsRunId: string | null | undefined,
	status: 'running' | 'succeeded' | 'failed' | 'stopped',
	at: Date = new Date()
): Promise<void> {
	if (!opentronsRunId) return;
	const time = status === 'running' ? { robotStartedAt: at } : { robotCompletedAt: at };
	try {
		await OpentronsRunRecord.updateOne(
			{ opentronsRunId, manufacturingRunId, status: { $nin: TERMINAL_RECORD } },
			{ $set: { status, ...time } }
		);
	} catch (e) {
		console.error('[run-lifecycle] run record status update failed:', e instanceof Error ? e.message : e);
	}
}

// ── start: prepare ─────────────────────────────────────────────────────────

type ParamDef = { variableName: string; type?: 'int' | 'float' | 'bool' | 'str'; default?: unknown };

/**
 * Coerce the operator's form values to the protocol schema's native types, then
 * add the wax partial-deck translation and the BIMS calibration RTPs. Moved
 * verbatim from both pages' startRun.
 */
export async function computeRunParameters(
	kind: FillKind,
	form: FormData,
	schema: unknown,
	robotId: string,
	deckBinding: any
): Promise<{ runTimeParameterValues: Record<string, number | string | boolean>; protocolParameters: Record<string, number | string | boolean> }> {
	const paramSchema = (Array.isArray(schema) ? schema : []) as ParamDef[];
	const runTimeParameterValues: Record<string, number | string | boolean> = {};
	const protocolParameters: Record<string, number | string | boolean> = {};
	for (const def of paramSchema) {
		const raw = form.get(`param_${def.variableName}`);
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

	if (kind === 'wax') {
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
	}

	// PRD 6: inject the BIMS-native calibration params (global offset +
	// calibrator point) for robots that have a captured offset. No-op for the
	// pre-cutover protocol (none of these RTPs declared) — see calibration-rtps.
	// Deck-keyed calibrator (2026-08-28): the fixture is bolted to the carriage,
	// so the run gets the point taught for the deck that is physically mounted —
	// deckBinding.particleDeviceId is the same id the .py reads at run start.
	const calRtps = await calibrationRtpValues(String(robotId), K[kind].processType, paramSchema as any, {
		deckKey: deckBinding?.particleDeviceId,
		deckLoadName: deckBinding?.deckLoadName
	});
	Object.assign(runTimeParameterValues, calRtps);
	Object.assign(protocolParameters, calRtps);
	return { runTimeParameterValues, protocolParameters };
}

type StartContext = { runId: string; run: any; robotId: string; robot: any; deckBinding: any };

/**
 * The start guards (both pages' startRun up to the freshness gate). `onGuards`
 * runs where the old code wrote the explicit test-fill AuditLog row.
 */
async function startContext(
	kind: FillKind,
	form: FormData,
	user: User,
	opts: { writeTestFillAudit: boolean }
): Promise<StartContext | ActionFail> {
	await connectDB();
	const runId = form.get('runId') as string;
	const opentronsProtocolId = form.get('opentronsProtocolId')?.toString();
	if (!runId) return actionFail(400, 'runId is required');
	if (!opentronsProtocolId) return actionFail(400, 'opentronsProtocolId is required (pick a protocol)');

	const run = (await model(kind).findById(runId).lean()) as any;
	if (!run) return actionFail(404, K[kind].notFound);
	const robotId = run.robot?._id;
	if (!robotId) return actionFail(400, K[kind].noRobot);

	if (kind === 'wax') {
		// UNTRACKED-FILL GUARD (2026-08-28). Runs were starting with no scanned
		// deck and no cartridgeIds — the robot filled real carts that no record
		// ever pointed at, so nothing could mark them wax_filled. A run may only
		// start without them as an EXPLICIT test fill (calibration/tuning).
		const testFill = form.get('testFillNoCartridges')?.toString() === 'true';
		if (!testFill && (!run.deckId || !run.cartridgeIds?.length)) {
			return actionFail(
				400,
				'This run has no scanned deck/cartridges — starting now would fill carts no record points at ' +
					'(they could never be marked wax filled). Scan the deck + cartridges first, or tick ' +
					'"Test fill — no cartridges tracked" if this is a calibration run.'
			);
		}
		if (opts.writeTestFillAudit && testFill && !run.cartridgeIds?.length) {
			try {
				await AuditLog.create({
					_id: generateId(),
					tableName: 'wax_filling_runs',
					recordId: runId,
					action: 'UPDATE',
					changedBy: user.username,
					changedAt: new Date(),
					newData: { testFillNoCartridges: true, note: 'explicit untracked test fill' }
				});
			} catch {
				/* non-fatal */
			}
		}
	}

	const robot = await getRobot(robotId);
	if (!robot) return actionFail(404, `Robot ${robotId} not found / not active`);

	// Deck identity guard. BIMS knows which deck the operator selected; the
	// robot picks its cartridge-deck definition independently, from a Particle
	// id it reads over serial. Prove the selected deck is actually bound to a
	// real definition before moving a pipette — an unbound or dangling deck is
	// how a calibrated deck ends up filling at someone else's coordinates.
	let deckBinding;
	try {
		deckBinding = await resolveDeckBinding(run?.deckId ?? null, { enforce: isHardenedRobot(robot) });
	} catch (e) {
		if (e instanceof DeckBindingError) return actionFail(400, e.message);
		throw e;
	}
	if (opts.writeTestFillAudit && deckBinding.warning) console.warn(`[${K[kind].log} startRun] ` + deckBinding.warning);
	return { runId, run, robotId: String(robotId), robot, deckBinding };
}

/**
 * Start PREPARE: guards, deck binding, the robot's current protocol entry, the
 * expected (live) wells and the RTP values; writes startIntent. The posted
 * opentronsProtocolId is intentionally NOT trusted — a page loaded before a
 * Sync would post the older upload.
 */
export async function startPrepare(
	kind: FillKind,
	form: FormData,
	user: User,
	line: Line
): Promise<{ prepared: StartPrepared; ctx: StartContext } | ActionFail> {
	const ctx = await startContext(kind, form, user, { writeTestFillAudit: true });
	if (isActionFail(ctx)) return ctx;
	const prior = ctx.run.startIntent;
	if (prior?.opentronsRunId && !prior.confirmedAt) {
		return actionFail(
			409,
			`A previous start created robot run ${prior.opentronsRunId} that was never confirmed — reload the page so BIMS can reconcile it before starting again.`
		);
	}
	if (prior?.uncertainAt) {
		return actionFail(
			409,
			"A previous start lost the robot's answer while creating the run — reload the page so BIMS can check the robot before starting again."
		);
	}
	const processType = K[kind].processType;
	const current = await currentProtocolEntry(ctx.robotId, processType);
	const expectedWells = await loadExpectedWells();
	let runTimeParameterValues: Record<string, unknown> | null = null;
	let createArgs: Record<string, unknown> | undefined;
	if (current) {
		const params = await computeRunParameters(kind, form, current.parametersSchema, ctx.robotId, ctx.deckBinding);
		runTimeParameterValues = params.runTimeParameterValues;
		createArgs = {
			protocolId: current.opentronsProtocolId,
			runTimeParameterValues: params.runTimeParameterValues,
			protocolParameters: params.protocolParameters,
			deckGeometry: ctx.deckBinding ?? null
		};
	}
	const token = generateId();
	await model(kind).updateOne(
		{ _id: ctx.runId },
		{
			$set: {
				startIntent: {
					token,
					requestedAt: new Date(),
					requestedBy: { _id: user._id, username: user.username },
					line,
					...(createArgs ? { createArgs } : {})
				}
			}
		}
	);
	return {
		prepared: { token, processType, protocolId: current?.opentronsProtocolId ?? null, expectedWells, runTimeParameterValues },
		ctx
	};
}

async function intentRun(kind: FillKind, runId: string, token: string): Promise<{ run: any } | ActionFail> {
	await connectDB();
	const run = (await model(kind).findById(runId).lean()) as any;
	if (!run) return actionFail(404, K[kind].notFound);
	if (!run.startIntent?.token || run.startIntent.token !== token) {
		return actionFail(409, 'This start was superseded or already finished — reload the page.');
	}
	return { run };
}

/** Start RESYNC, part 1: the stored .py + labware bundle for the stale case. */
export async function startBundle(kind: FillKind, runId: string, token: string, staleDetail: string): Promise<ProtocolUploadBundle | ActionFail> {
	const r = await intentRun(kind, runId, token);
	if (isActionFail(r)) return r;
	const robot = await getRobot(r.run.robot?._id);
	if (!robot) return actionFail(404, `Robot ${r.run.robot?._id} not found / not active`);
	try {
		return await resyncBundle(robot, K[kind].processType, staleDetail);
	} catch (e) {
		return actionFail(502, e instanceof Error ? e.message : 'unknown');
	}
}

/**
 * Start RESYNC, part 2: record the fresh upload (repoint the robot's entry, as
 * the old gate did right after the upload) and return the RTP values for ITS
 * schema. The resync AuditLog is written by the next confirm, once verified.
 */
export async function startRecordResync(
	kind: FillKind,
	form: FormData,
	token: string,
	uploadedRaw: unknown,
	from: string | null,
	reason: string,
	user: User
): Promise<{ runTimeParameterValues: Record<string, unknown> } | ActionFail> {
	const uploaded = validUploadedResult(uploadedRaw);
	if (!uploaded) return actionFail(400, 'upload result is malformed');
	const ctx = await startContext(kind, form, user, { writeTestFillAudit: false });
	if (isActionFail(ctx)) return ctx;
	if (ctx.run.startIntent?.token !== token) return actionFail(409, 'This start was superseded or already finished — reload the page.');
	const processType = K[kind].processType;
	let fileName: string;
	try {
		fileName = (await storedRunProtocol(processType, reason)).fileName;
	} catch (e) {
		return actionFail(502, e instanceof Error ? e.message : 'unknown');
	}
	await recordResyncUpload(ctx.robotId, processType, fileName, uploaded, user.username);
	const params = await computeRunParameters(kind, form, uploaded.parametersSchema, ctx.robotId, ctx.deckBinding);
	await model(kind).updateOne(
		{ _id: ctx.runId, 'startIntent.token': token },
		{
			$set: {
				'startIntent.createArgs': {
					protocolId: uploaded.opentronsProtocolId,
					runTimeParameterValues: params.runTimeParameterValues,
					protocolParameters: params.protocolParameters,
					deckGeometry: ctx.deckBinding ?? null
				},
				'startIntent.resync': { from, to: uploaded.opentronsProtocolId, reason: String(reason).slice(0, 2000), audited: false }
			}
		}
	);
	return { runTimeParameterValues: params.runTimeParameterValues };
}

async function auditPendingResync(kind: FillKind, run: any, username: string, line: Line) {
	const rs = run.startIntent?.resync;
	if (!rs || rs.audited) return;
	await auditResync(String(run.robot?._id), K[kind].processType, rs.from ?? null, rs.to, rs.reason, username, line);
	await model(kind).updateOne({ _id: run._id }, { $set: { 'startIntent.resync.audited': true } });
}

// ── start: confirm ─────────────────────────────────────────────────────────

/**
 * Start CONFIRM, one call per phase of the robot half:
 *   created  the robot accepted POST /runs → OpentronsRunRecord (+ the verified
 *            resync's AuditLog), intent remembers the run id
 *   played   play accepted → auto_resume_run, run status Running, AuditLog,
 *            intent cleared
 *   failed   the start stopped → intent cleared (kept when the create answer
 *            was lost: the reconcile rules the run in or out)
 * Idempotent: a repeated `played` for the run already Running is a success.
 */
export async function startConfirm(
	kind: FillKind,
	runId: string,
	token: string,
	obs: StartConfirmObs,
	user: User,
	line: Line
): Promise<Record<string, unknown> | ActionFail> {
	await connectDB();
	const run = (await model(kind).findById(runId).lean()) as any;
	if (!run) return actionFail(404, K[kind].notFound);
	const intent = run.startIntent;
	if (!intent?.token || intent.token !== token) {
		if (obs.phase === 'played' && run.status === 'Running' && run.opentronsRunId === obs.opentronsRunId) {
			return { success: true, opentronsRunId: run.opentronsRunId, alreadyRecorded: true };
		}
		return actionFail(409, 'This start was superseded or already finished — reload the page.');
	}

	if (obs.phase === 'failed') {
		if (obs.stage === 'create' || obs.stage === 'play') await auditPendingResync(kind, run, user.username, line);
		if (obs.stage === 'create' && obs.uncertain) {
			await model(kind).updateOne({ _id: runId, 'startIntent.token': token }, { $set: { 'startIntent.uncertainAt': new Date() } });
		} else {
			await model(kind).updateOne({ _id: runId, 'startIntent.token': token }, { $unset: { startIntent: '' } });
		}
		return { error: String(obs.message ?? 'Run start failed').slice(0, 2000) };
	}

	if (!validRunId(obs.opentronsRunId)) return actionFail(400, 'opentronsRunId is malformed');
	const createArgs = intent.createArgs as
		| { protocolId: string; runTimeParameterValues: Record<string, unknown>; protocolParameters: Record<string, unknown>; deckGeometry: any }
		| undefined;
	if (!createArgs) return actionFail(409, 'This start has no run arguments — reload the page.');
	const robotId = String(run.robot?._id ?? '');

	if (obs.phase === 'created') {
		if (obs.protocolId !== createArgs.protocolId) return actionFail(409, 'The robot run was created for a different protocol than BIMS prepared.');
		if (intent.opentronsRunId && intent.opentronsRunId !== obs.opentronsRunId) {
			return actionFail(409, `This start already created robot run ${intent.opentronsRunId}.`);
		}
		await auditPendingResync(kind, run, user.username, line);
		const robot = await getRobot(robotId);
		// Geometry provenance. Record exactly which deck definition, at which
		// version and content hash, this run was started against — the definition
		// is edited in place, so these coordinates stop existing the moment anyone
		// jogs the deck again.
		try {
			const exists = await OpentronsRunRecord.findOne({ opentronsRunId: obs.opentronsRunId }).select('_id').lean();
			if (!exists) {
				await OpentronsRunRecord.create({
					_id: generateId(),
					manufacturingRunId: String(runId),
					manufacturingRunType: K[kind].processType,
					robotId,
					robotName: robot?.name ?? null,
					opentronsRunId: obs.opentronsRunId,
					opentronsProtocolId: createArgs.protocolId,
					runtimeParameters: createArgs.runTimeParameterValues,
					deckGeometry: createArgs.deckGeometry,
					status: 'created',
					robotCreatedAt: new Date(),
					startedBy: user.username
				});
			}
		} catch (e) {
			// Provenance must never block a fill that the robot already accepted.
			console.error(`[${K[kind].log} startRun] could not write run record:`, e instanceof Error ? e.message : e);
		}
		await model(kind).updateOne({ _id: runId, 'startIntent.token': token }, { $set: { 'startIntent.opentronsRunId': obs.opentronsRunId } });
		return { success: true, opentronsRunId: obs.opentronsRunId };
	}

	// phase 'played'
	if (intent.opentronsRunId && intent.opentronsRunId !== obs.opentronsRunId) {
		return actionFail(409, `This start created robot run ${intent.opentronsRunId}, not ${obs.opentronsRunId}.`);
	}
	const opentronsRunId = obs.opentronsRunId;
	const protocolParameters = (createArgs.protocolParameters ?? {}) as Record<string, unknown>;
	const robot = await getRobot(robotId);

	// Auto-resume the protocol's initial off-deck "confirm deck loaded" pause
	// on the robot. The operator is routed to the gallery and won't be on the
	// run page to click Resume, so the daemon watches the run and resumes the
	// first pause once. Fire-and-forget. (Both lines, until TAILNET-5 S6.)
	try {
		await Ot2BridgeCommand.create({
			_id: generateId(),
			robotId,
			deviceId: bridgeDeviceIdForRobot((robot ?? run.robot ?? {}) as any),
			kind: 'auto_resume_run',
			payload: { runId: opentronsRunId },
			ttlMs: 120_000,
			requestedBy: user.username
		});
	} catch (e) {
		console.warn(`[${kind === 'wax' ? 'startRun' : 'reagent startRun'}] could not enqueue auto_resume_run:`, e instanceof Error ? e.message : e);
	}

	// Carry the previous run's tip state forward as this run's "before"
	// snapshot. If the operator checked tiprack_refilled, the protocol
	// will reset to index 0 — record that intent so post-run consumed
	// math is sane (we treat refilled-mid-flight separately).
	const prevTipRun = (await model(kind)
		.findOne({
			'robot._id': robotId,
			'pipetteTipState.after.nextTipIndex': { $exists: true },
			_id: { $ne: runId }
		})
		.sort({ runEndTime: -1 })
		.select('pipetteTipState')
		.lean()) as any;

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

	if (kind === 'wax') {
		const now = new Date();
		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: {
				status: 'Running',
				runStartTime: now,
				opentronsRunId,
				protocolParameters,
				'pipetteTipState.before': beforeSnap,
				'pipetteTipState.rackRefilledDuringRun': refilled
			},
			$unset: { startIntent: '' }
		});
		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: runId,
			action: 'UPDATE',
			changedBy: user.username,
			changedAt: now,
			newData: { status: 'Running', opentronsRunId, protocolParameters, pipetteTipBefore: beforeSnap.nextTipIndex, line }
		});
		await setRunRecordStatus(runId, opentronsRunId, 'running', now);
		return { success: true, opentronsRunId };
	}

	// Estimated finish time. Driven by how many wells the selected reagent rows
	// will actually fill, not by cartridge count alone — see
	// src/lib/manufacturing/reagent-run-estimate.ts for the model and the fit.
	const settingsDoc = (await ManufacturingSettings.findById('default').lean()) as any;
	const cartridgeCount = run.cartridgeCount ?? run.cartridgesFilled?.length ?? 0;
	const estimate = estimateReagentRunSeconds(protocolParameters as any, cartridgeCount, settingsDoc?.reagentFilling);
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
		},
		$unset: { startIntent: '' }
	});
	await AuditLog.create({
		_id: generateId(),
		tableName: 'reagent_batch_records',
		recordId: runId,
		action: 'UPDATE',
		changedBy: user.username,
		changedAt: runStartTime,
		newData: { status: 'Running', runStartTime, opentronsRunId, protocolParameters, pipetteTipBefore: beforeSnap.nextTipIndex, line }
	});
	await setRunRecordStatus(runId, opentronsRunId, 'running', runStartTime);
	return { success: true, opentronsRunId };
}

/**
 * The queue line's startRun: the whole start in ONE server action — the same
 * sequence the tailnet browser runs, with the robot half over serverTransport.
 */
export async function startRunQueue(kind: FillKind, form: FormData, user: User): Promise<{ success: true; opentronsRunId: string } | ActionFail> {
	let ctx: StartContext | null = null;
	const failOf = (r: ActionFail): StepError => ({ error: r.fail.error, status: r.fail.status });
	const verb: SequenceVerb = (v, a) => runVerb(serverTransport(ctx!.robot), v, a);
	const steps: StartRunSteps = {
		prepare: async () => {
			const r = await startPrepare(kind, form, user, 'queue');
			if (isActionFail(r)) return failOf(r);
			ctx = r.ctx;
			return r.prepared;
		},
		bundle: async (token, stale) => {
			const r = await startBundle(kind, ctx!.runId, token, stale);
			return isActionFail(r) ? failOf(r) : r;
		},
		recordResync: async (token, uploaded, from, reason) => {
			const r = await startRecordResync(kind, form, token, uploaded, from, reason, user);
			return isActionFail(r) ? failOf(r) : r;
		},
		confirm: async (token, obs) => {
			const r = await startConfirm(kind, ctx!.runId, token, obs, user, 'queue');
			return isActionFail(r) ? failOf(r) : r;
		},
		verb
	};
	const out = await startRunSequence(steps);
	if (!out.ok) return actionFail(out.status, out.error);
	return { success: true, opentronsRunId: out.opentronsRunId };
}

// ── finish ─────────────────────────────────────────────────────────────────

/** The finish guards (both pages' recordRunFinished before the robot read). */
export async function finishPrecheck(kind: FillKind, runId: string): Promise<ActionFail | { already: true } | { run: any; robot: any }> {
	await connectDB();
	if (!runId) return actionFail(400, 'runId is required');
	const run = (await model(kind).findById(runId).lean()) as any;
	if (!run) return actionFail(404, K[kind].notFound);
	if (!run.opentronsRunId) return actionFail(400, K[kind].noOtRun);
	// Idempotent: already recorded. Return success without re-fetching.
	if (run.pipetteTipState?.after?.nextTipIndex != null) return { already: true };
	const robot = await getRobot(run.robot?._id);
	if (!robot) return actionFail(404, 'Robot no longer reachable');
	return { run, robot };
}

/**
 * Finish CONFIRM — today's recordRunFinished body after the command read,
 * given {finalStatus, tips}. Guarded by pipetteTipState.after (a second
 * confirm for the same run is `alreadyRecorded`).
 */
export async function finishConfirm(kind: FillKind, run: any, obs: FinishObservation, user: User, line: Line): Promise<Record<string, unknown>> {
	const runId = String(run._id);
	const finalStatus = obs.finalStatus;
	const { nextTipIndex, pickUpTipCount } = obs.tips;
	const now = new Date();
	const before = run.pipetteTipState?.before?.nextTipIndex ?? 0;
	const refilledMidRun = !!run.pipetteTipState?.rackRefilledDuringRun;
	// If the rack was refilled mid-run, consumed = (96 - before) + (final index).
	// Otherwise just the delta.
	const finalIndex = nextTipIndex ?? before + pickUpTipCount;
	const consumed = refilledMidRun ? Math.max(0, 96 - before) + finalIndex : Math.max(0, finalIndex - before);

	const upd = await model(kind).updateOne(
		// The filter IS the idempotency guard: only a run whose tips aren't recorded yet.
		{ _id: runId, 'pipetteTipState.after.nextTipIndex': null },
		{
			$set: {
				// Persist the terminal .py status on the run so the Running stage can
				// reveal the deck-removal / Complete controls after it finishes (reload-safe).
				opentronsRunFinalStatus: finalStatus || 'unknown',
				'pipetteTipState.after': {
					nextTipIndex: finalIndex,
					hostname: run.pipetteTipState?.before?.hostname ?? null,
					capturedAt: now
				},
				'pipetteTipState.consumed': consumed
			}
		}
	);
	if ((upd as any)?.matchedCount === 0) return { success: true, alreadyRecorded: true };

	await AuditLog.create({
		_id: generateId(),
		tableName: K[kind].table,
		recordId: runId,
		action: 'UPDATE',
		changedBy: user.username,
		changedAt: now,
		newData: { opentronsRunFinalStatus: finalStatus || 'unknown', pipetteTipAfter: finalIndex, pipetteTipConsumed: consumed, line }
	});

	if (finalStatus === 'succeeded' || finalStatus === 'failed' || finalStatus === 'stopped') {
		await setRunRecordStatus(runId, run.opentronsRunId, finalStatus, now);
	}

	if (kind === 'wax') {
		// AUTO-ADVANCE (2026-08-28): a run that completes with no cancellation IS
		// the statement that every cart on it got wax. No deck-removed / fridge
		// ceremony — flip the whole run to wax_filled and complete it right here.
		// Stopped/failed runs are left for cancel/abort (smart abort advances only
		// the carts the robot log proves were finished).
		let advanced = 0;
		if (finalStatus === 'succeeded') {
			const r = await advanceCartsToWaxFilled(run, run.cartridgeIds ?? [], user, 'run-complete auto-advance');
			advanced = r.advanced;
			await WaxFillingRun.findByIdAndUpdate(runId, { $set: { status: 'completed', robotReleasedAt: now, runEndTime: now } });
		}
		return { success: true, consumed, nextTipIndex: finalIndex, advanced, autoCompleted: finalStatus === 'succeeded' };
	}

	// AUTO-COMPLETE (2026-08-28, parity with wax): a reagent run that lands
	// `succeeded` IS done — finalize immediately so the robot frees the
	// moment the .py finishes instead of waiting for a Complete click.
	// Stopped/failed runs are left Running for cancel/abort.
	if (finalStatus === 'succeeded') await finalizeReagentRun(runId, user, 'auto (run finished)');
	return { success: true, consumed, nextTipIndex: finalIndex, autoCompleted: finalStatus === 'succeeded' };
}

/** The queue line's recordRunFinished: guards → run.commands (server) → confirm. */
export async function recordRunFinishedQueue(kind: FillKind, runId: string, finalStatusRaw: string, user: User): Promise<Record<string, unknown> | ActionFail> {
	const pre = await finishPrecheck(kind, runId);
	if (isActionFail(pre)) return pre;
	if ('already' in pre) return { success: true, alreadyRecorded: true };
	let obs: FinishObservation;
	try {
		// Pull commands. The OT-2 paginates — one large page covers a typical run.
		obs = await observeRunFinished((v, a) => runVerb(serverTransport(pre.robot), v, a), pre.run.opentronsRunId, finalStatusRaw);
	} catch (err) {
		console.error(`[${kind === 'wax' ? 'WAX-FILLING' : 'REAGENT-FILLING'}] recordRunFinished: command fetch failed:`, err);
		obs = { finalStatus: String(finalStatusRaw ?? '').toLowerCase(), tips: { nextTipIndex: null, pickUpTipCount: 0 } };
	}
	return finishConfirm(kind, pre.run, obs, user, 'queue');
}

// ── cancel / abort ─────────────────────────────────────────────────────────

export type StopAction = 'cancel' | 'abort';
const WAX_STOP_SELECT = 'cartridgeIds opentronsRunId robot deckId waxTubeId waxSourceLot operator runStartTime protocolParameters status';

/** The cancel/abort guards and the run snapshot the confirm needs. */
export async function stopPrecheck(kind: FillKind, action: StopAction, runId: string): Promise<ActionFail | { run: any }> {
	await connectDB();
	if (kind === 'wax') {
		// Once the OT-2 has finished (robotReleasedAt set), the run is committed
		// and can no longer be cancelled/aborted. Individual cartridges can still
		// be rejected at QC; whole-run abort is no longer the right tool.
		const existing = (await WaxFillingRun.findById(runId).select('robotReleasedAt').lean()) as any;
		if (existing?.robotReleasedAt) {
			return actionFail(
				400,
				action === 'cancel'
					? 'Cannot cancel: the OT-2 has already completed this run. Reject individual cartridges at QC instead.'
					: 'Cannot abort: the OT-2 has already completed this run. Reject individual cartridges at QC instead.'
			);
		}
		const run = (await WaxFillingRun.findById(runId).select(WAX_STOP_SELECT).lean()) as any;
		return { run };
	}
	if (action === 'cancel') {
		// Per-cartridge rejection happens later on the Reagent Inspect page.
		const existing = (await ReagentBatchRecord.findById(runId).select('robotReleasedAt opentronsRunId robot status').lean()) as any;
		if (existing?.robotReleasedAt) {
			return actionFail(400, 'Cannot cancel: the OT-2 has already completed this run. Reject individual cartridges on Reagent Inspect instead.');
		}
		return { run: existing };
	}
	const abortTarget = (await ReagentBatchRecord.findById(runId).select('opentronsRunId robot status').lean()) as any;
	return { run: abortTarget };
}

/** Whether a stop needs the wax filled-wells read (smart abort). */
export function wantsFilledWells(kind: FillKind, run: any): boolean {
	return kind === 'wax' && ((run?.cartridgeIds ?? []) as string[]).length > 0 && !!run?.opentronsRunId;
}

/** Already cancelled/aborted — a repeated tailnet confirm is a no-op (R2). */
export function alreadyStopped(kind: FillKind, run: any): boolean {
	const s = String(run?.status ?? '');
	return kind === 'wax' ? s === 'aborted' : s === 'Cancelled' || s === 'Aborted';
}

/**
 * Cancel/Abort CONFIRM — today's cancelRun/abortRun body after the robot stop,
 * given {stopWarning, filledWells}. filledWells null = not read / read failed →
 * every scanned cart reverts (the old "smart abort check failed" path).
 */
export async function stopConfirm(
	kind: FillKind,
	action: StopAction,
	runId: string,
	run: any,
	fields: { reason?: string | null; photoUrl?: string | null },
	obs: StopObservation,
	user: User,
	line: Line
): Promise<Record<string, unknown>> {
	const now = new Date();
	const reason = fields.reason || (action === 'cancel' ? 'Cancelled by operator' : 'Aborted');
	const warning = obs.stopWarning ?? undefined;

	if (kind === 'wax') {
		const scannedIds: string[] = (run?.cartridgeIds ?? []) as string[];
		await WaxFillingRun.findByIdAndUpdate(runId, { $set: { status: 'aborted', abortReason: reason, runEndTime: now } });

		// SMART ABORT (2026-08-28): the robot's own log proves which carts it
		// finished before the stop — mark THOSE wax_filled instead of reverting
		// real fills to backing. Only fully-filled carts count.
		const tag = action === 'cancel' ? 'cancelRun' : 'abortRun';
		if (scannedIds.length > 0 && run?.opentronsRunId) {
			if (obs.filledWells) {
				try {
					const filled = cartsFilledFromWells(obs.filledWells, run.protocolParameters);
					const filledIds = filled.map((n) => scannedIds[n - 1]).filter(Boolean);
					if (filledIds.length > 0) {
						const r = await advanceCartsToWaxFilled(run, filledIds, user, action === 'cancel' ? 'smart-abort (cancel)' : 'smart-abort');
						console.log(`[${tag}] smart abort: ${r.advanced} filled cart(s) marked wax_filled before revert`);
					}
				} catch (e) {
					console.error(`[${tag}] smart abort check failed (reverting all):`, e instanceof Error ? e.message : e);
				}
			} else {
				console.error(`[${tag}] smart abort check failed (reverting all): robot command log unavailable`);
			}
		}

		// Cartridges scanned onto the deck never actually got wax-filled.
		// WI-01-originated carts go back to 'backing' (the operator returns
		// them to the oven; their original ovenEntryTime is preserved).
		// Test-mode synthetics (no parentLotRecordId) are deleted.
		if (scannedIds.length > 0) {
			await CartridgeRecord.updateMany(
				{
					_id: { $in: scannedIds },
					'waxFilling.runId': runId,
					status: 'wax_filling',
					'backing.parentLotRecordId': { $exists: true, $ne: null }
				},
				{ $set: { status: 'backing' }, $unset: { waxFilling: '' } }
			);
			// Test-mode synthetics (no parentLotRecordId) — hard-deleted through the
			// driver: Model.deleteMany is blocked by the sacred middleware.
			await hardDeleteUnfinalizedCartridges(
				{ _id: { $in: scannedIds }, 'waxFilling.runId': runId, status: 'wax_filling' },
				{
					reason: action === 'cancel' ? 'Wax run cancelled — synthetic (test-mode) cartridge removed' : 'Wax run aborted — synthetic (test-mode) cartridge removed',
					user: user as any,
					oldData: { runId }
				}
			);
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: runId,
			action: 'UPDATE',
			changedBy: user.username,
			changedAt: now,
			newData: { status: 'aborted', abortReason: reason, revertedToBacking: scannedIds.length, line }
		});
		await setRunRecordStatus(runId, run?.opentronsRunId, 'stopped', now);
		await notifyRunLifecycle({
			runId,
			runType: 'wax_filling',
			status: action === 'cancel' ? 'cancelled' : 'aborted',
			operator: user.username,
			reason
		});
		return { success: true, warning };
	}

	if (action === 'cancel') {
		await ReagentBatchRecord.findByIdAndUpdate(runId, { $set: { status: 'Cancelled', abortReason: reason, runEndTime: now } });
	} else {
		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: { status: 'Aborted', abortReason: reason, abortPhotoUrl: fields.photoUrl || undefined, runEndTime: now }
		});
	}
	// Clean up cartridges that were in reagent_filling phase for this run
	await CartridgeRecord.bulkWrite([
		{
			updateMany: {
				filter: { 'reagentFilling.runId': runId, status: 'reagent_filling' },
				update: { $set: { status: 'wax_filled' }, $unset: { reagentFilling: '' } }
			}
		}
	]);
	await AuditLog.create({
		_id: generateId(),
		tableName: 'reagent_batch_records',
		recordId: runId,
		action: 'UPDATE',
		changedBy: user.username,
		changedAt: now,
		newData: { status: action === 'cancel' ? 'Cancelled' : 'Aborted', abortReason: reason, line }
	});
	await setRunRecordStatus(runId, run?.opentronsRunId, 'stopped', now);
	return { success: true, warning };
}

/**
 * Server-line stop — was stopRobotRun(): never-started and offline robots are
 * answered here; the stop itself is the shared 'run.stop' verb.
 */
async function stopOverServer(run: any, readFilledWells: boolean): Promise<StopObservation> {
	const opentronsRunId: string | undefined = run?.opentronsRunId;
	const robotId: string | undefined = run?.robot?._id;
	if (!opentronsRunId || !robotId) return { stopWarning: null, filledWells: null }; // never started on a robot
	const robot = await getRobot(robotId);
	if (!robot) return { stopWarning: `Robot ${robotId} is offline — confirm the run is stopped on the device.`, filledWells: null };
	return observeRunStopped((v, a) => runVerb(serverTransport(robot), v, a), opentronsRunId, { readFilledWells });
}

/** The queue line's cancelRun / abortRun: guards → run.stop (+ wells) → confirm. */
export async function stopRunQueue(
	kind: FillKind,
	action: StopAction,
	runId: string,
	fields: { reason?: string | null; photoUrl?: string | null },
	user: User
): Promise<Record<string, unknown> | ActionFail> {
	const pre = await stopPrecheck(kind, action, runId);
	if (isActionFail(pre)) return pre;
	const obs = await stopOverServer(pre.run, wantsFilledWells(kind, pre.run));
	return stopConfirm(kind, action, runId, pre.run, fields, obs, user, 'queue');
}

// ── load reconcile for an interrupted start ────────────────────────────────

/**
 * If a start intent is still set, find the robot's run for it and confirm it,
 * or clear the intent once nothing can still be in flight. Never throws; the
 * returned banner is shown on the page while the intent stays unresolved.
 */
export async function reconcileStartIntent(kind: FillKind, run: any, user: User): Promise<{ changed: boolean; banner: string | null }> {
	const intent = run?.startIntent;
	if (!intent?.token) return { changed: false, banner: null };
	const age = Date.now() - new Date(intent.requestedAt ?? 0).getTime();
	const banner = () => (age > START_INTENT_BANNER_MS ? START_INTERRUPTED_BANNER : null);
	const runId = String(run._id);
	const line = validLine(intent.line);
	try {
		const createArgs = intent.createArgs as { protocolId?: string } | undefined;
		const robot = await getRobot(run.robot?._id);
		if (!robot) return { changed: false, banner: banner() };
		const list = await runVerb(serverTransport(robot), 'run.list', {});
		if (list.status !== 200) return { changed: false, banner: banner() };
		const body = list.body as { runs: Array<{ id: string; status: string | null; protocolId: string | null; createdAt: string | null }>; current: any };
		const requestedAt = new Date(intent.requestedAt ?? 0).getTime();
		const mine =
			(intent.opentronsRunId ? body.runs.find((r) => r.id === intent.opentronsRunId) : null) ??
			(body.current &&
			createArgs?.protocolId &&
			body.current.protocolId === createArgs.protocolId &&
			new Date(body.current.createdAt ?? 0).getTime() >= requestedAt - 60_000
				? body.current
				: null);
		if (mine && createArgs?.protocolId) {
			if (!intent.opentronsRunId) {
				await startConfirm(kind, runId, intent.token, { phase: 'created', opentronsRunId: mine.id, protocolId: createArgs.protocolId }, user, line);
			}
			const idle = String(mine.status ?? '').toLowerCase() === 'idle';
			if (idle && age <= START_INTENT_CLEAR_MS) {
				// Created and not played YET: a start may still be between its create
				// and its play right now. Record the run id only; never fail a start
				// that can still finish (its own `played` confirm would then be refused).
				return { changed: !intent.opentronsRunId, banner: banner() };
			}
			if (!idle) {
				await startConfirm(kind, runId, intent.token, { phase: 'played', opentronsRunId: mine.id }, user, line);
			} else {
				// Created but never played: the start stopped there. Same outcome as a
				// play failure — the run stays in Loading and the operator starts again.
				await startConfirm(
					kind,
					runId,
					intent.token,
					{ phase: 'failed', stage: 'play', message: 'start interrupted before play (reconciled on load)', opentronsRunId: mine.id },
					user,
					line
				);
			}
			await AuditLog.create({
				_id: generateId(),
				tableName: K[kind].table,
				recordId: runId,
				action: 'start_intent_reconciled',
				changedBy: user.username,
				changedAt: new Date(),
				newData: { opentronsRunId: mine.id, robotStatus: mine.status ?? null, line }
			});
			return { changed: true, banner: null };
		}
		const uncertainFor = intent.uncertainAt ? Date.now() - new Date(intent.uncertainAt).getTime() : 0;
		if (age > START_INTENT_CLEAR_MS || uncertainFor > START_INTENT_UNCERTAIN_CLEAR_MS) {
			await model(kind).updateOne({ _id: runId, 'startIntent.token': intent.token }, { $unset: { startIntent: '' } });
			await AuditLog.create({
				_id: generateId(),
				tableName: K[kind].table,
				recordId: runId,
				action: 'start_intent_cleared',
				changedBy: user.username,
				changedAt: new Date(),
				newData: { reason: 'no robot run found for the interrupted start', requestedAt: intent.requestedAt ?? null, line }
			});
			return { changed: true, banner: null };
		}
		return { changed: false, banner: banner() };
	} catch (e) {
		console.error(`[${K[kind].log} load] start reconcile failed:`, e instanceof Error ? e.message : e);
		return { changed: false, banner: banner() };
	}
}


// ── the tailnet line's form actions (both fill pages spread these) ─────────

/** Parse a JSON form field; undefined when absent or not JSON. */
function jsonField(form: FormData, key: string): unknown {
	const raw = form.get(key);
	if (typeof raw !== 'string' || raw === '') return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/** A browser-reported start observation, re-validated (only its shape is trusted). */
export function validStartObs(v: unknown): StartConfirmObs | null {
	const o = v as any;
	if (!o || typeof o !== 'object') return null;
	if (o.phase === 'created') {
		return validRunId(o.opentronsRunId) && validRunId(o.protocolId)
			? { phase: 'created', opentronsRunId: o.opentronsRunId, protocolId: o.protocolId }
			: null;
	}
	if (o.phase === 'played') return validRunId(o.opentronsRunId) ? { phase: 'played', opentronsRunId: o.opentronsRunId } : null;
	if (o.phase === 'failed') {
		if (!['freshness', 'create', 'play'].includes(o.stage) || typeof o.message !== 'string') return null;
		if (o.opentronsRunId != null && !validRunId(o.opentronsRunId)) return null;
		return {
			phase: 'failed',
			stage: o.stage,
			message: o.message.slice(0, 2000),
			...(o.opentronsRunId ? { opentronsRunId: o.opentronsRunId } : {}),
			...(o.uncertain === true ? { uncertain: true } : {})
		};
	}
	return null;
}

/**
 * The prepare/confirm form actions of the two-phase lifecycle (OT2-TAILNET-5
 * §7.1), for `...lifecycleActions('wax')` in a page's `actions`. Each one is a
 * short DB-only call (well under 10 s): the robot half runs in the browser over
 * the session. The single queue-line actions (startRun, recordRunFinished,
 * cancelRun, abortRun) stay on the page and reach the same functions.
 *
 *   startPrepare       guards + RTP → startIntent; {token, protocolId, expectedWells, runTimeParameterValues}
 *   startBundle        {runId, token, staleDetail} → {bundle} (only when the check found stale)
 *   startRecordResync  the start form + {token, uploaded, from, reason} → {runTimeParameterValues}
 *   startConfirm       {runId, token, obs} (phase created | played | failed)
 *   finishConfirm      {runId, finalStatus, tips}
 *   cancelConfirm      {runId, reason, stopWarning, filledWells}
 *   abortConfirm       {runId, reason, photoUrl, stopWarning, filledWells}
 */
export function lifecycleActions(kind: FillKind) {
	const perm = kind === 'wax' ? 'waxFilling:write' : 'reagentFilling:write';
	type Ev = { request: Request; locals: App.Locals };
	const begin = async ({ request, locals }: Ev): Promise<{ form: FormData; user: User }> => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user as any, perm);
		await connectDB();
		return { form: await request.formData(), user: { _id: locals.user._id, username: locals.user.username } };
	};
	const failOut = (r: ActionFail) => fail(r.fail.status, { ...r.fail });
	const str = (form: FormData, k: string) => (form.get(k)?.toString() ?? '').trim();

	return {
		startPrepare: async (ev: Ev) => {
			const { form, user } = await begin(ev);
			const r = await startPrepare(kind, form, user, validLine(form.get('line')));
			if (isActionFail(r)) return failOut(r);
			return { ...r.prepared };
		},

		startBundle: async (ev: Ev) => {
			const { form } = await begin(ev);
			const runId = str(form, 'runId');
			const token = str(form, 'token');
			if (!runId || !token) return fail(400, { error: 'runId and token are required' });
			const r = await startBundle(kind, runId, token, str(form, 'staleDetail').slice(0, 2000) || 'stale');
			if (isActionFail(r)) return failOut(r);
			return { bundle: r };
		},

		startRecordResync: async (ev: Ev) => {
			const { form, user } = await begin(ev);
			const token = str(form, 'token');
			if (!token) return fail(400, { error: 'token is required' });
			const from = str(form, 'from');
			const r = await startRecordResync(kind, form, token, jsonField(form, 'uploaded'), from || null, str(form, 'reason').slice(0, 2000), user);
			if (isActionFail(r)) return failOut(r);
			return r;
		},

		startConfirm: async (ev: Ev) => {
			const { form, user } = await begin(ev);
			const runId = str(form, 'runId');
			const token = str(form, 'token');
			const obs = validStartObs(jsonField(form, 'obs'));
			if (!runId || !token) return fail(400, { error: 'runId and token are required' });
			if (!obs) return fail(400, { error: 'start observation is malformed' });
			const r = await startConfirm(kind, runId, token, obs, user, validLine(form.get('line')));
			if (isActionFail(r)) return failOut(r);
			return r;
		},

		finishConfirm: async (ev: Ev) => {
			const { form, user } = await begin(ev);
			const runId = str(form, 'runId');
			const finalStatus = validFinalStatus(form.get('finalStatus'));
			const tips = validTips(jsonField(form, 'tips'));
			if (finalStatus === null) return fail(400, { error: 'finalStatus is malformed' });
			if (!tips) return fail(400, { error: 'tip observation is malformed' });
			const pre = await finishPrecheck(kind, runId);
			if (isActionFail(pre)) return failOut(pre);
			if ('already' in pre) return { success: true, alreadyRecorded: true };
			return finishConfirm(kind, pre.run, { finalStatus, tips }, user, validLine(form.get('line')));
		},

		cancelConfirm: async (ev: Ev) => stopConfirmAction(kind, 'cancel', await begin(ev)),
		abortConfirm: async (ev: Ev) => stopConfirmAction(kind, 'abort', await begin(ev))
	};
}

async function stopConfirmAction(kind: FillKind, action: StopAction, { form, user }: { form: FormData; user: User }) {
	const runId = (form.get('runId')?.toString() ?? '').trim();
	if (!runId) return fail(400, { error: 'runId is required' });
	const stopWarning = validStopWarning(form.get('stopWarning')?.toString());
	const filledWells = validFilledWells(jsonField(form, 'filledWells') ?? null);
	if (stopWarning === undefined) return fail(400, { error: 'stopWarning is malformed' });
	if (filledWells === undefined) return fail(400, { error: 'filledWells is malformed' });
	const pre = await stopPrecheck(kind, action, runId);
	if (isActionFail(pre)) return fail(pre.fail.status, { ...pre.fail });
	// R2: a repeated confirm for the same run + action (a retry after a lost
	// answer) is a no-op, not a second revert.
	if (alreadyStopped(kind, pre.run)) return { success: true, alreadyRecorded: true };
	const fields = {
		reason: (form.get('reason') as string | null) || null,
		photoUrl: (form.get('photoUrl') as string | null) || null
	};
	return stopConfirm(kind, action, runId, pre.run, fields, { stopWarning, filledWells }, user, validLine(form.get('line')));
}
