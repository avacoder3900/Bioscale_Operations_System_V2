/**
 * OT-2 robot protocol — ONE implementation of every robot verb that BIMS may
 * send either through its own API route (the Vercel → Mongo queue) or straight
 * from the operator's browser over the tailnet (OT2-TAILNET-4).
 *
 * WHY THIS FILE EXISTS
 * The same verb (pause a run, jog the gantry) can now travel two ways. If each
 * way had its own copy of the request/validation/error logic, the two copies
 * would drift — "pause" would mean slightly different things on the two lines.
 * So the logic lives here once and only the transport differs:
 *
 *   server route  → runVerb(serverTransport(robot), …)  → robotGet/robotPost (queue on Vercel)
 *   browser       → runVerb(browserTransport(directUrl), …) → fetch(https://ot2-xxx.ts.net/…)
 *
 * `runVerb` returns exactly what the BIMS route returns ({status, body}), so a
 * caller cannot tell which line answered — except by asking the session.
 *
 * Isomorphic: no server imports, no DB. Code here was MOVED from the route
 * handlers and src/lib/server/opentrons/maintenance.ts, not rewritten; keep the
 * behaviour byte-identical when editing.
 */

/** Minimal transport. Both implementations return a native Response. */
export interface Ot2Transport {
	get(path: string, opts?: { timeoutMs?: number }): Promise<Response>;
	post(path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<Response>;
	delete(path: string, opts?: { timeoutMs?: number }): Promise<Response>;
}

/** Exactly the HTTP status + JSON body the equivalent BIMS API route returns. */
export type VerbResult = { status: number; body: unknown };

export type Ot2Verb =
	| 'run.get'
	| 'run.action'
	| 'mx.open'
	| 'mx.close'
	| 'mx.loadLabware'
	| 'mx.pickUpTip'
	| 'mx.jog'
	| 'mx.position'
	| 'mx.moveTo'
	| 'mx.moveToWell'
	| 'mx.home'
	| 'mx.dropTip';

/**
 * Verbs that move the gantry or take over the maintenance-run engine — deferred
 * to the queue while a daemon job (sweep / deck scan / tip cal) holds the robot.
 */
export const MOTION_VERBS: ReadonlySet<Ot2Verb> = new Set([
	'mx.open',
	'mx.close',
	'mx.loadLabware',
	'mx.pickUpTip',
	'mx.jog',
	'mx.moveTo',
	'mx.moveToWell',
	'mx.home',
	'mx.dropTip'
]);

/**
 * Verbs whose effect cannot safely be repeated if the answer was lost: a
 * relative jog would move twice; a second pick-up would find the first tip on
 * and make the client drop a fresh one. Never auto-retried on failover.
 */
export const NO_RETRY_VERBS: ReadonlySet<Ot2Verb> = new Set(['mx.jog', 'mx.pickUpTip']);

/** Verbs that need a labware definition from BIMS before touching the robot. */
export const DEFINITION_VERBS: ReadonlySet<Ot2Verb> = new Set(['mx.loadLabware', 'mx.pickUpTip']);

/** BIMS API route path for a verb (relative to /api/opentrons-lab/robots/:id). */
export function verbRoute(verb: Ot2Verb, args: Record<string, unknown>): { method: 'GET' | 'POST' | 'DELETE'; path: string } {
	const rid = encodeURIComponent(String(args.rid ?? ''));
	const mr = encodeURIComponent(String(args.runId ?? ''));
	switch (verb) {
		case 'run.get':
			return { method: 'GET', path: `/runs/${rid}` };
		case 'run.action':
			return { method: 'POST', path: `/runs/${rid}/actions` };
		case 'mx.open':
			return { method: 'POST', path: `/maintenance` };
		case 'mx.close':
			return { method: 'DELETE', path: `/maintenance/${mr}` };
		case 'mx.loadLabware':
			return { method: 'POST', path: `/maintenance/${mr}/load-labware` };
		case 'mx.pickUpTip':
			return { method: 'POST', path: `/maintenance/${mr}/pick-up-tip` };
		case 'mx.jog':
			return { method: 'POST', path: `/maintenance/${mr}/jog` };
		case 'mx.position':
			return { method: 'POST', path: `/maintenance/${mr}/position` };
		case 'mx.moveTo':
			return { method: 'POST', path: `/maintenance/${mr}/move-to` };
		case 'mx.moveToWell':
			return { method: 'POST', path: `/maintenance/${mr}/move-to-well` };
		case 'mx.home':
			return { method: 'POST', path: `/maintenance/${mr}/home` };
		case 'mx.dropTip':
			return { method: 'POST', path: `/maintenance/${mr}/drop-tip` };
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** A SvelteKit `error(status, message)` renders as {"message": ...}. Mirror it. */
function fail(status: number, message: string): VerbResult {
	return { status, body: { message } };
}
const ok = (body: unknown, status = 200): VerbResult => ({ status, body });
const msgOf = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ── run control (was routes/api/opentrons-lab/robots/[id]/runs/[rid]/…) ─────

/** The OT-2 has no 'resume' actionType — a paused run is resumed with 'play'. */
export const ACTION_TO_OT2: Record<string, string> = {
	play: 'play',
	pause: 'pause',
	stop: 'stop',
	resume: 'play'
};
export const VALID_RUN_ACTIONS = ['play', 'pause', 'stop', 'resume'] as const;

async function runGet(t: Ot2Transport, rid: string): Promise<VerbResult> {
	try {
		const res = await t.get(`/runs/${rid}`);
		const data = await res.json();
		return ok(data);
	} catch (e) {
		return fail(502, `Failed to reach robot: ${e instanceof Error ? e.message : 'unknown'}`);
	}
}

async function runAction(t: Ot2Transport, rid: string, action: unknown): Promise<VerbResult> {
	if (!VALID_RUN_ACTIONS.includes(action as any)) {
		return fail(400, 'action must be play, pause, stop, or resume');
	}
	try {
		const res = await t.post(`/runs/${rid}/actions`, {
			data: { actionType: ACTION_TO_OT2[action as string] }
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			const detail = (body as any).errors?.[0]?.detail ?? `Robot returned ${res.status}`;
			// A 4xx from the robot means the action is invalid for the run's CURRENT
			// state (e.g. pause when already paused) — benign; the client reconciles
			// by re-polling. 5xx/other = a real failure.
			const conflict = res.status >= 400 && res.status < 500;
			return {
				status: conflict ? 409 : 502,
				body: { ok: false, action, robotStatus: res.status, detail, conflict }
			};
		}
		return ok({ ok: true, action });
	} catch (e) {
		return fail(502, msgOf(e, 'Failed to control run'));
	}
}

// ── maintenance commands (was src/lib/server/opentrons/maintenance.ts) ──────

export type JogAxis = 'x' | 'y' | 'leftZ' | 'rightZ';
export const VALID_JOG_AXES: JogAxis[] = ['x', 'y', 'leftZ', 'rightZ'];
export const OT2_ALL_AXES = ['x', 'y', 'leftZ', 'rightZ', 'leftPlunger', 'rightPlunger'] as const;
export type HomeAxis = (typeof OT2_ALL_AXES)[number];

/**
 * Send a command into a maintenance run. waitUntilComplete=true makes the
 * robot block until the command settles before returning, which is what
 * jog/move callers want (so the response position is final).
 */
export async function sendMaintenanceCommand(
	t: Ot2Transport,
	runId: string,
	commandType: string,
	params: Record<string, unknown>,
	opts: { waitUntilComplete?: boolean; timeoutMs?: number } = {}
): Promise<any> {
	const waitUntilComplete = opts.waitUntilComplete ?? true;
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const qs = new URLSearchParams();
	if (waitUntilComplete) qs.set('waitUntilComplete', 'true');
	if (timeoutMs) qs.set('timeout', String(timeoutMs));
	const path = `/maintenance_runs/${runId}/commands?${qs.toString()}`;
	// Client HTTP timeout must exceed the robot-side waitUntilComplete hold
	// (timeoutMs) or slow commands like home abort early as "fetch failed".
	const res = await t.post(path, { data: { commandType, intent: 'setup', params } }, { timeoutMs: timeoutMs + 10_000 });
	if (!res.ok) {
		const body: any = await res.json().catch(() => ({}));
		// Opentrons command errors use {errors:[{detail}]}; FastAPI request-validation
		// (422) uses {detail:[{loc,msg}]} — surface the field path so "field required"
		// is actually diagnosable instead of a bare message.
		const fastapiDetail = Array.isArray(body?.detail)
			? body.detail.map((d: any) => `${(d?.loc ?? []).join('.')}: ${d?.msg ?? ''}`).join('; ')
			: typeof body?.detail === 'string'
				? body.detail
				: null;
		const detail = body?.errors?.[0]?.detail ?? fastapiDetail ?? body?.message;
		throw new Error(`${commandType}: ${detail ?? `robot returned ${res.status}`}`);
	}
	// CRITICAL: the OT-2 returns HTTP 201 even when a command failed; the
	// per-command status lives at body.data.status. A "failed" status with
	// no http error here is the difference between a sweep that silently
	// no-ops the gantry and one that fails loudly. Detect it.
	const body: any = await res.json();
	const innerStatus = body?.data?.status;
	if (innerStatus === 'failed') {
		const err = body?.data?.error ?? {};
		const detail = err.detail ?? err.errorType ?? 'unknown command failure';
		const type = err.errorType ? `[${err.errorType}] ` : '';
		throw new Error(`${commandType} failed: ${type}${detail}`);
	}
	return body;
}

/** Home all axes (or a subset). Always sends the explicit axis set — some OT-2
 *  firmware rejects an empty params object with "field required". */
export async function home(t: Ot2Transport, runId: string, axes?: HomeAxis[]): Promise<void> {
	await sendMaintenanceCommand(t, runId, 'home', { axes: axes ?? [...OT2_ALL_AXES] }, { waitUntilComplete: true, timeoutMs: 60_000 });
}

/** Relative move on one axis. moveRelative's axis is 'x'|'y'|'z' — the mount is
 *  fixed by pipetteId, so leftZ/rightZ both map to 'z'. */
export async function jog(t: Ot2Transport, runId: string, pipetteId: string, axis: JogAxis, distance: number): Promise<void> {
	const moveAxis = axis === 'leftZ' || axis === 'rightZ' ? 'z' : axis;
	await sendMaintenanceCommand(t, runId, 'moveRelative', { pipetteId, axis: moveAxis, distance }, { waitUntilComplete: true, timeoutMs: 30_000 });
}

/** Move to absolute deck coordinates. forceDirect defaults to true (scanner
 *  sweeps don't need the safety arc). */
export async function moveTo(
	t: Ot2Transport,
	runId: string,
	pipetteId: string,
	coords: { x: number; y: number; z: number },
	opts: { minimumZHeight?: number; forceDirect?: boolean; speed?: number } = {}
): Promise<void> {
	const forceDirect = opts.forceDirect ?? true;
	await sendMaintenanceCommand(
		t,
		runId,
		'moveToCoordinates',
		{
			pipetteId,
			coordinates: coords,
			...(opts.minimumZHeight !== undefined ? { minimumZHeight: opts.minimumZHeight } : {}),
			// Optional max travel speed (mm/s); omitted → robot default speed.
			...(opts.speed !== undefined ? { speed: opts.speed } : {}),
			forceDirect
		},
		{ waitUntilComplete: true, timeoutMs: 30_000 }
	);
}

/** Current gantry position via savePosition (reliable XYZ readback after moves). */
export async function getCurrentPosition(
	t: Ot2Transport,
	runId: string,
	pipetteId: string
): Promise<{ x: number; y: number; z: number } | null> {
	const result = (await sendMaintenanceCommand(t, runId, 'savePosition', { pipetteId }, { waitUntilComplete: true, timeoutMs: 10_000 })) as {
		data?: { result?: { position?: { x: number; y: number; z: number } } };
	};
	const p = result?.data?.result?.position;
	if (!p) return null;
	return { x: p.x, y: p.y, z: p.z };
}

/** Move to a well's nominal position via the SAFE ARC (forceDirect=false). */
export async function moveToWell(
	t: Ot2Transport,
	runId: string,
	pipetteId: string,
	labwareId: string,
	wellName: string,
	opts: { zOffsetMm?: number; minimumZHeight?: number; xOffsetMm?: number; yOffsetMm?: number } = {}
): Promise<void> {
	await sendMaintenanceCommand(
		t,
		runId,
		'moveToWell',
		{
			pipetteId,
			labwareId,
			wellName,
			// x/y offset = tip-cal adjust folded in → one move to well+adjust.
			wellLocation: { origin: 'top', offset: { x: opts.xOffsetMm ?? 0, y: opts.yOffsetMm ?? 0, z: opts.zOffsetMm ?? 2 } },
			// false ⇒ travel via the safe arc (up to minimumZHeight, over, down).
			forceDirect: false,
			...(opts.minimumZHeight !== undefined ? { minimumZHeight: opts.minimumZHeight } : {})
		},
		{ waitUntilComplete: true, timeoutMs: 30_000 }
	);
}

/** Drop whatever tip the run models into the fixed trash. */
export async function dropTipInTrash(t: Ot2Transport, runId: string, pipetteId: string): Promise<void> {
	await sendMaintenanceCommand(
		t,
		runId,
		'moveToAddressableAreaForDropTip',
		{ pipetteId, addressableAreaName: 'fixedTrash', offset: { x: 0, y: 0, z: 0 }, alternateDropLocation: false },
		{ waitUntilComplete: true, timeoutMs: 30_000 }
	);
	await sendMaintenanceCommand(t, runId, 'dropTipInPlace', { pipetteId }, { waitUntilComplete: true, timeoutMs: 30_000 });
}

// ── maintenance-run lifecycle + labware (was maintenance.ts) ────────────────

/**
 * Thrown by loadLabwareInRun when the target slot already holds a DIFFERENT
 * labware in this maintenance run (e.g. the reagent tiprack was loaded to
 * calibrate it, then a wax tip pickup wants the 20µL rack in the same slot 11).
 * The OT-2 has no gripper and moveLabware/offDeck pauses the run, so the slot
 * can't be freed in place — the caller recovers by opening a fresh run instead
 * of leaking a raw LocationIsOccupiedError to the operator.
 */
export class SlotOccupiedError extends Error {
	readonly code = 'SLOT_OCCUPIED';
	constructor(
		readonly slot: string,
		readonly existingLoadName: string,
		readonly wantedLoadName: string
	) {
		super(
			`Slot ${slot} already holds ${existingLoadName}; cannot load ${wantedLoadName} there. ` +
				`Reopen the maintenance run to clear it.`
		);
		this.name = 'SlotOccupiedError';
	}
}

// A protocol run left non-terminal (commonly a `paused` run from the off-deck
// initial pause that was never resumed/closed) keeps holding the OT-2 run
// engine, so the robot refuses new maintenance runs with this error. We
// auto-clear the stale run and retry — the same self-heal the bridge daemon
// does for deck-scan/sweep (scripts/ot2-bridge.py).
const PROTOCOL_RUN_CONFLICT = 'protocol run is active';
const ACTIVE_RUN_STATES = new Set(['running', 'finishing']);
const TERMINAL_RUN_STATES = new Set(['stopped', 'failed', 'succeeded']);

async function currentProtocolRun(t: Ot2Transport): Promise<{ id: string; status: string | null } | null> {
	const res = await t.get('/runs');
	if (!res.ok) return null;
	const body = (await res.json().catch(() => ({}))) as any;
	const href: string = body?.links?.current?.href ?? '';
	const curId = href ? href.split('/').pop() ?? null : null;
	if (!curId) return null;
	const run = (body?.data ?? []).find((r: any) => r.id === curId);
	return { id: curId, status: run?.status ?? null };
}

/**
 * Free the run engine when a non-terminal protocol run is blocking a new
 * maintenance run. Throws if the blocking run is genuinely ACTIVE
 * (running/finishing) — we never silently kill a live run.
 */
async function clearStaleProtocolRun(t: Ot2Transport): Promise<void> {
	const run = await currentProtocolRun(t);
	if (!run) return;
	const status = (run.status ?? '').toLowerCase();
	if (TERMINAL_RUN_STATES.has(status)) return; // terminal-but-current doesn't block
	if (ACTIVE_RUN_STATES.has(status)) {
		throw new Error(`Robot has an ACTIVE protocol run (status=${status}) — stop that run before opening a maintenance run.`);
	}
	// Stale: paused / idle / blocked-by-open-door / stop-requested / awaiting-recovery
	await t.post(`/runs/${run.id}/actions`, { data: { actionType: 'stop' } }).catch(() => {});
	for (let i = 0; i < 6; i++) {
		const cur = await currentProtocolRun(t);
		if (!cur || TERMINAL_RUN_STATES.has((cur.status ?? '').toLowerCase())) break;
		await new Promise((r) => setTimeout(r, 500));
	}
	await t.delete(`/runs/${run.id}`).catch(() => {});
}

/** Open a new maintenance run. Returns the run id. */
export async function openMaintenanceRun(t: Ot2Transport): Promise<{ runId: string }> {
	// OT-2 maintenance_runs endpoint is JSON:API style — requires the `data`
	// envelope even when there are no attributes. Empty body returns
	// `Field required` at /data.
	const open = async () => t.post('/maintenance_runs', { data: {} });
	let res = await open();
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as any;
		const detail = body?.errors?.[0]?.detail ?? `Robot returned ${res.status} on /maintenance_runs`;
		if (String(detail).toLowerCase().includes(PROTOCOL_RUN_CONFLICT)) {
			await clearStaleProtocolRun(t); // throws if genuinely active
			res = await open();
			if (!res.ok) {
				const retryBody = (await res.json().catch(() => ({}))) as any;
				throw new Error(retryBody?.errors?.[0]?.detail ?? `Robot returned ${res.status} on /maintenance_runs`);
			}
		} else {
			throw new Error(detail);
		}
	}
	const body = (await res.json()) as { data?: { id?: string } };
	const runId = body?.data?.id;
	if (!runId) throw new Error('Robot did not return a maintenance run id');
	return { runId };
}

/** Close (delete) a maintenance run. Best-effort — does not throw on 404. */
export async function closeMaintenanceRun(t: Ot2Transport, runId: string): Promise<void> {
	const res = await t.delete(`/maintenance_runs/${runId}`);
	if (!res.ok && res.status !== 404) {
		const body = await res.json().catch(() => ({}));
		throw new Error((body as any)?.errors?.[0]?.detail ?? `Robot returned ${res.status} on close maintenance run`);
	}
}

/**
 * Discover an available pipette on the robot. Prefers left mount.
 * Returns the OT-2's pipette name (e.g. 'p20_single_gen2') and mount.
 */
export async function discoverPipette(
	t: Ot2Transport,
	preferredMount?: 'left' | 'right' | null
): Promise<{ pipetteName: string; mount: 'left' | 'right' } | null> {
	try {
		const res = await t.get('/pipettes');
		if (!res.ok) return null;
		const body = (await res.json()) as Record<string, { name?: string; model?: string }>;
		// /pipettes returns { left: {name|model, ...}, right: {...} }. We need the
		// `name` (technical id like 'p20_single_gen2'); `model` is also accepted
		// as a fallback. Honor preferredMount when both mounts are populated.
		const mounts: Array<'left' | 'right'> =
			preferredMount === 'left' ? ['left', 'right'] : preferredMount === 'right' ? ['right', 'left'] : ['left', 'right'];
		for (const m of mounts) {
			const entry = body?.[m];
			if (entry?.name) return { pipetteName: entry.name, mount: m };
		}
		for (const m of mounts) {
			const entry = body?.[m];
			if (entry?.model) return { pipetteName: entry.model, mount: m };
		}
		return null;
	} catch (e) {
		// Log the underlying reason; still return null so the caller proceeds to
		// openMaintenanceRun, which will surface the same error.
		console.warn('[discoverPipette] failed:', e instanceof Error ? e.message : e);
		return null;
	}
}

/** Load a pipette into the maintenance run; returns the run-scoped pipetteId. */
export async function loadPipetteInRun(t: Ot2Transport, runId: string, pipetteName: string, mount: 'left' | 'right'): Promise<string> {
	const result = (await sendMaintenanceCommand(t, runId, 'loadPipette', { pipetteName, mount }, { waitUntilComplete: true })) as {
		data?: { result?: { pipetteId?: string } };
	};
	const pid = result?.data?.result?.pipetteId;
	if (!pid) throw new Error('loadPipette did not return a pipetteId');
	return pid;
}

/** Register a custom labware definition onto a maintenance run. */
export async function registerLabwareDefinition(t: Ot2Transport, runId: string, definition: unknown): Promise<void> {
	const res = await t.post(`/maintenance_runs/${runId}/labware_definitions`, { data: definition });
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error((body as any)?.errors?.[0]?.detail ?? `Robot returned ${res.status} registering labware definition`);
	}
}

async function loadedLabwareAtSlot(
	t: Ot2Transport,
	runId: string,
	slot: string
): Promise<{ id: string; loadName: string; definitionUri: string | null } | null> {
	const res = await t.get(`/maintenance_runs/${runId}`);
	if (!res.ok) return null;
	const body = (await res.json().catch(() => ({}))) as any;
	const lw = (body?.data?.labware ?? []) as Array<any>;
	const match = lw.find((x) => String(x?.location?.slotName ?? '') === String(slot));
	return match?.id ? { id: match.id, loadName: match.loadName, definitionUri: match.definitionUri ?? null } : null;
}

/**
 * Load an (already-registered) labware def into the run at a slot; returns labwareId.
 * Idempotent: reuses the slot's labware when it is the same one. `hardened`
 * (the robot's DECK_HARDENING_ROBOT_IDS status, decided by BIMS) makes reuse
 * require the full namespace/loadName/version identity, so a deck edit can't
 * leave the run bound to stale geometry.
 */
export async function loadLabwareInRun(
	t: Ot2Transport,
	runId: string,
	args: { namespace: string; loadName: string; version: number; slot: string },
	opts: { hardened: boolean }
): Promise<string> {
	const existing = await loadedLabwareAtSlot(t, runId, args.slot).catch(() => null);
	const wantUri = `${args.namespace}/${args.loadName}/${args.version}`;
	if (existing && existing.loadName === args.loadName) {
		// On a robot that is not opted in, keep the old loadName-only reuse.
		if (!opts.hardened) return existing.id;
		if (!existing.definitionUri || existing.definitionUri === wantUri) return existing.id;
		// Same labware, different version: stale geometry — make the caller reopen.
		throw new SlotOccupiedError(args.slot, existing.definitionUri, wantUri);
	}
	// A DIFFERENT labware already occupies the slot — it can't be freed in place.
	if (existing && existing.loadName !== args.loadName) {
		throw new SlotOccupiedError(args.slot, existing.loadName, args.loadName);
	}
	const result = (await sendMaintenanceCommand(
		t,
		runId,
		'loadLabware',
		{ location: { slotName: args.slot }, loadName: args.loadName, namespace: args.namespace, version: args.version },
		{ waitUntilComplete: true, timeoutMs: 30_000 }
	)) as { data?: { result?: { labwareId?: string } } };
	const id = result?.data?.result?.labwareId;
	if (!id) throw new Error('loadLabware did not return a labwareId');
	return id;
}

/** Pick up a tip from a (loaded) tiprack. */
export async function pickUpTip(t: Ot2Transport, runId: string, pipetteId: string, labwareId: string, wellName: string): Promise<void> {
	await sendMaintenanceCommand(
		t,
		runId,
		'pickUpTip',
		{ pipetteId, labwareId, wellName, wellLocation: { origin: 'top', offset: { x: 0, y: 0, z: 0 } } },
		{ waitUntilComplete: true, timeoutMs: 30_000 }
	);
}

/**
 * Identity must come from the blob the robot indexes, not the DB columns — the
 * BIMS resolver (resolveLabwareForRobot) computes it once and passes it as
 * labwareNamespace / labwareVersion alongside the definition.
 */
function labwareIdentity(args: Record<string, unknown>) {
	const d = (args.definition ?? {}) as any;
	return {
		namespace: String(args.labwareNamespace ?? d.namespace ?? ''),
		version: Number(args.labwareVersion ?? d.version ?? 1)
	};
}

// ── BIMS-side records that follow a successful robot verb ───────────────────

/**
 * What BIMS must record after a verb succeeds on the robot. The server writes
 * it (src/lib/server/opentrons/maintenance-records.ts) whichever line ran the
 * robot part: the queue route calls it directly, the browser posts it to
 * /direct-record. Null when the verb records nothing.
 */
export type MaintenanceRecord =
	| { event: 'maintenance_run_open'; runId: string; pipetteId?: string; pipetteName?: string; mount?: string }
	| { event: 'maintenance_run_close'; runId: string }
	| { event: 'studio_tip_pickup'; tiprackLoadName: string; tipWell: string };

export function maintenanceRecordFor(verb: Ot2Verb, args: Record<string, unknown>, r: VerbResult): MaintenanceRecord | null {
	if (r.status >= 300) return null;
	const b = (r.body ?? {}) as any;
	if (verb === 'mx.open') return { event: 'maintenance_run_open', runId: b.runId, pipetteId: b.pipetteId, pipetteName: b.pipetteName, mount: b.mount };
	if (verb === 'mx.close') return { event: 'maintenance_run_close', runId: String(args.runId) };
	if (verb === 'mx.pickUpTip') return { event: 'studio_tip_pickup', tiprackLoadName: String(args.tiprackLoadName), tipWell: String(args.tipWell ?? 'A1') };
	return null;
}

// ── verb dispatcher (validation + response shaping, was the route handlers) ─

/**
 * Run one verb over a transport and return what the BIMS route returns.
 * `args` is the route's path params (rid / runId) merged with its JSON body.
 * Never throws for robot/validation errors — they become a VerbResult.
 */
export async function runVerb(t: Ot2Transport, verb: Ot2Verb, args: Record<string, unknown>): Promise<VerbResult> {
	switch (verb) {
		case 'run.get':
			return runGet(t, String(args.rid));
		case 'run.action':
			return runAction(t, String(args.rid), args.action);
	}

	if (verb === 'mx.open') {
		// We deliberately do NOT trust a caller-supplied pipetteName (it may be a
		// human label like "20 microliter"); the technical name comes from the
		// robot's /pipettes, honouring the requested mount as a preference.
		const requestedMount = args.mount === 'left' || args.mount === 'right' ? args.mount : undefined;
		let pipetteName: string | undefined;
		let mount: 'left' | 'right' | undefined = requestedMount;
		try {
			const discovered = await discoverPipette(t, requestedMount ?? null);
			if (discovered) {
				pipetteName = discovered.pipetteName;
				mount = discovered.mount;
			}
			const { runId } = await openMaintenanceRun(t);
			let pipetteId: string | undefined;
			if (pipetteName && mount) {
				try {
					pipetteId = await loadPipetteInRun(t, runId, pipetteName, mount);
				} catch (e) {
					// Return the run anyway so the caller can still home or close it.
					console.warn('[maintenance] loadPipette failed:', e instanceof Error ? e.message : e);
				}
			}
			return ok({ runId, pipetteId, pipetteName, mount });
		} catch (e) {
			return fail(502, msgOf(e, 'Failed to open maintenance run'));
		}
	}

	const runId = String(args.runId);
	const pipetteId = args.pipetteId;

	if (verb === 'mx.close') {
		try {
			await closeMaintenanceRun(t, runId);
			return ok({ ok: true });
		} catch (e) {
			return fail(502, msgOf(e, 'Failed to close maintenance run'));
		}
	}

	if (verb === 'mx.loadLabware') {
		const loadName = args.loadName;
		if (!loadName || typeof loadName !== 'string') return fail(400, 'loadName required');
		if (!args.definition) return fail(400, 'definition required (resolve the labware in BIMS first)');
		const { namespace, version } = labwareIdentity(args);
		const slot = String(args.slot ?? '1');
		try {
			await registerLabwareDefinition(t, runId, args.definition);
			const labwareId = await loadLabwareInRun(t, runId, { namespace, loadName, version, slot }, { hardened: args.hardened === true });
			return ok({ labwareId });
		} catch (e) {
			return fail(502, msgOf(e, 'Failed to load labware'));
		}
	}

	if (verb === 'mx.pickUpTip') {
		const tiprackLoadName = args.tiprackLoadName;
		if (!pipetteId || typeof pipetteId !== 'string') return fail(400, 'pipetteId required');
		if (!tiprackLoadName || typeof tiprackLoadName !== 'string') return fail(400, 'tiprackLoadName required');
		if (!args.definition) return fail(400, 'definition required (resolve the tiprack in BIMS first)');
		const { namespace, version } = labwareIdentity(args);
		const slot = String(args.slot ?? '11');
		const tipWell = String(args.tipWell ?? 'A1');
		try {
			await registerLabwareDefinition(t, runId, args.definition);
			// loadLabwareInRun is idempotent (reuses the slot if already loaded).
			const tiprackLabwareId = await loadLabwareInRun(t, runId, { namespace, loadName: tiprackLoadName, version, slot }, { hardened: args.hardened === true });
			try {
				await pickUpTip(t, runId, pipetteId, tiprackLabwareId, tipWell);
			} catch (tipErr) {
				// The engine refuses a pick-up while it still models a tip. Report it with
				// a stable code so the client can drop first (or reopen the run) — never
				// swallow it as success (2026-09-23: Studio said "picked up" and seated nothing).
				const msg = tipErr instanceof Error ? tipErr.message : String(tipErr);
				if (/tip.*(attach|present|already)|already.*tip|should not have a tip/i.test(msg)) {
					return { status: 409, body: { code: 'TIP_ALREADY_ATTACHED', message: msg, tiprackLabwareId } };
				}
				throw tipErr;
			}
			return ok({ tiprackLabwareId });
		} catch (e) {
			// A different rack occupies the slot: the client reopens the run and retries.
			if (e instanceof SlotOccupiedError) return { status: 409, body: { code: e.code, message: e.message } };
			return fail(502, msgOf(e, 'Failed to pick up tip'));
		}
	}

	if (verb === 'mx.home') {
		const axes = Array.isArray(args.axes) ? (args.axes as HomeAxis[]) : undefined;
		try {
			await home(t, runId, axes);
			return ok({ ok: true });
		} catch (e) {
			return fail(502, msgOf(e, 'Failed to home robot'));
		}
	}

	if (!pipetteId || typeof pipetteId !== 'string') return fail(400, 'pipetteId required');

	switch (verb) {
		case 'mx.jog': {
			const { axis, distance } = args;
			if (!VALID_JOG_AXES.includes(axis as JogAxis)) return fail(400, `axis must be one of ${VALID_JOG_AXES.join(', ')}`);
			if (!isFiniteNum(distance)) return fail(400, 'distance must be a finite number');
			try {
				await jog(t, runId, pipetteId, axis as JogAxis, distance);
				return ok({ ok: true });
			} catch (e) {
				return fail(502, msgOf(e, 'Failed to jog robot'));
			}
		}
		case 'mx.position': {
			try {
				const pos = await getCurrentPosition(t, runId, pipetteId);
				if (!pos) return fail(502, 'Robot did not return a position');
				return ok({ position: pos });
			} catch (e) {
				return fail(502, msgOf(e, 'Failed to read position'));
			}
		}
		case 'mx.moveTo': {
			const { x, y, z, minimumZHeight, forceDirect, speed } = args;
			if (!isFiniteNum(x)) return fail(400, 'x must be a finite number');
			if (!isFiniteNum(y)) return fail(400, 'y must be a finite number');
			if (!isFiniteNum(z)) return fail(400, 'z must be a finite number');
			if (speed !== undefined && (!isFiniteNum(speed) || speed <= 0)) {
				return fail(400, 'speed must be a positive finite number (mm/s)');
			}
			try {
				await moveTo(t, runId, pipetteId, { x, y, z }, {
					minimumZHeight: typeof minimumZHeight === 'number' ? minimumZHeight : undefined,
					forceDirect: typeof forceDirect === 'boolean' ? forceDirect : undefined,
					speed: typeof speed === 'number' ? speed : undefined
				});
				return ok({ ok: true });
			} catch (e) {
				return fail(502, msgOf(e, 'Failed to move robot'));
			}
		}
		case 'mx.moveToWell': {
			const { labwareId, wellName } = args;
			const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
			if (!labwareId || typeof labwareId !== 'string') return fail(400, 'labwareId required');
			if (!wellName || typeof wellName !== 'string') return fail(400, 'wellName required');
			try {
				await moveToWell(t, runId, pipetteId, labwareId, wellName, {
					zOffsetMm: num(args.zOffsetMm),
					minimumZHeight: num(args.minimumZHeight),
					xOffsetMm: num(args.xOffsetMm),
					yOffsetMm: num(args.yOffsetMm)
				});
				return ok({ ok: true });
			} catch (e) {
				return fail(502, msgOf(e, 'Failed to move to well'));
			}
		}
		case 'mx.dropTip': {
			try {
				await dropTipInTrash(t, runId, pipetteId);
				return ok({ dropped: true });
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				// No tip modelled → nothing for the engine to drop. Not an error for the caller.
				if (/no tip|without a tip|does not have a tip|not.*attached/i.test(msg)) return ok({ dropped: false, message: msg });
				return fail(502, msg || 'Failed to drop tip');
			}
		}
	}
	return fail(400, `unknown verb ${verb}`);
}

// ── browser transport ──────────────────────────────────────────────────────

/**
 * Transport that talks to the robot directly (tailnet HTTPS front for :31950).
 * Same header robotFetch sends. A network failure throws a TypeError / an
 * AbortError(TimeoutError) — the session uses that to decide failover; a robot
 * HTTP error comes back as a normal Response.
 */
export function browserTransport(directUrl: string, fetchImpl: typeof fetch = fetch): Ot2Transport {
	const base = directUrl.replace(/\/+$/, '');
	const signalFor = (ms?: number) => AbortSignal.timeout(ms ?? 30_000);
	return {
		get: (path, opts) =>
			fetchImpl(`${base}${path}`, { headers: { 'opentrons-version': '3' }, signal: signalFor(opts?.timeoutMs) }),
		post: (path, body, opts) =>
			fetchImpl(`${base}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'opentrons-version': '3' },
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: signalFor(opts?.timeoutMs)
			}),
		delete: (path, opts) =>
			fetchImpl(`${base}${path}`, {
				method: 'DELETE',
				headers: { 'opentrons-version': '3' },
				signal: signalFor(opts?.timeoutMs)
			})
	};
}
