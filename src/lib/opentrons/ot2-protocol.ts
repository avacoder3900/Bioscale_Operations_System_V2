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

import type { BridgeClient } from './bridge-client';
import { submitAutoResume } from './fill-bridge-jobs';

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
	| 'mx.dropTip'
	// OT2-TAILNET-5 S1: the fill-page run lifecycle + protocol upload.
	| 'run.list'
	| 'run.create'
	| 'run.stop'
	| 'run.commands'
	| 'run.ensureFresh'
	| 'run.uploadProtocol'
	| 'mx.command';

/** The OT2-TAILNET-5 verbs, served on the queue line by POST /verb (not a route each). */
export const LIFECYCLE_VERBS: ReadonlySet<Ot2Verb> = new Set([
	'run.list',
	'run.create',
	'run.stop',
	'run.commands',
	'run.ensureFresh',
	'run.uploadProtocol',
	'mx.command'
]);

/** Lifecycle verbs that only read the robot (manufacturing:read on the queue route). */
export const READ_ONLY_VERBS: ReadonlySet<Ot2Verb> = new Set(['run.list', 'run.commands', 'run.ensureFresh']);

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
export const NO_RETRY_VERBS: ReadonlySet<Ot2Verb> = new Set([
	'mx.jog',
	'mx.pickUpTip',
	// A second POST /runs makes a second robot run; a second upload a second
	// protocol; an arbitrary maintenance command may be relative. Reads and
	// stops (run.list / run.commands / run.ensureFresh / run.stop) are safe.
	'run.create',
	'run.uploadProtocol',
	'mx.command'
]);

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
		case 'run.list':
		case 'run.create':
		case 'run.stop':
		case 'run.commands':
		case 'run.ensureFresh':
		case 'run.uploadProtocol':
		case 'mx.command': {
			// One queue route for every lifecycle verb. The verb and the path params
			// ride in the query string: the session strips rid/runId from the JSON
			// body it forwards (they are line-only args for the maintenance routes).
			const q = new URLSearchParams({ verb });
			if (args.rid != null && args.rid !== '') q.set('rid', String(args.rid));
			if (args.runId != null && args.runId !== '') q.set('runId', String(args.runId));
			return { method: 'POST', path: `/verb?${q.toString()}` };
		}
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

/**
 * The robot's CURRENT run from a GET /runs body: `links.current.href` names it,
 * and its row in `data` carries the status. Null when the robot has no current run.
 */
export function currentRunFromList(body: any): { id: string; status: string | null; run: any | null } | null {
	const href: string = body?.links?.current?.href ?? '';
	const curId = href ? href.split('/').pop() ?? null : null;
	if (!curId) return null;
	const run = (body?.data ?? []).find((r: any) => r.id === curId);
	return { id: curId, status: run?.status ?? null, run: run ?? null };
}

async function currentProtocolRun(t: Ot2Transport): Promise<{ id: string; status: string | null } | null> {
	const res = await t.get('/runs');
	if (!res.ok) return null;
	const body = (await res.json().catch(() => ({}))) as any;
	const cur = currentRunFromList(body);
	return cur ? { id: cur.id, status: cur.status } : null;
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
		case 'run.list':
			return runList(t);
		case 'run.create':
			return runCreate(t, args.protocolId, args.runTimeParameterValues);
		case 'run.stop':
			return runStop(t, args.rid);
		case 'run.commands':
			return runCommands(t, args.rid, args.pageLength, args.maxPages);
		case 'run.ensureFresh':
			return runEnsureFresh(t, args);
		case 'run.uploadProtocol':
			return runUploadProtocol(t, args);
		case 'mx.command':
			return mxCommand(t, args);
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

// ── run lifecycle (OT2-TAILNET-5 S1: moved out of the fill-page servers,
//    protocol-freshness.ts and proxy.ts — same requests, same messages) ──────

/** A robot run command as the fill-page parsers read it. */
export type RunCommand = { commandType: string; params?: { message?: string } & Record<string, unknown> };

const isFormData = (v: unknown): v is FormData => typeof FormData !== 'undefined' && v instanceof FormData;

async function runList(t: Ot2Transport): Promise<VerbResult> {
	try {
		const res = await t.get('/runs');
		if (!res.ok) return fail(502, `Robot returned ${res.status} listing runs`);
		const body = (await res.json().catch(() => ({}))) as any;
		const cur = currentRunFromList(body);
		const runs = ((body?.data ?? []) as any[]).map((r) => ({
			id: r?.id ?? null,
			status: r?.status ?? null,
			protocolId: r?.protocolId ?? null,
			createdAt: r?.createdAt ?? null,
			current: r?.current === true || (!!cur && r?.id === cur.id)
		}));
		return ok({
			currentRunId: cur?.id ?? null,
			current: cur
				? { id: cur.id, status: cur.status, protocolId: cur.run?.protocolId ?? null, createdAt: cur.run?.createdAt ?? null }
				: null,
			links: body?.links ?? null,
			runs
		});
	} catch (e) {
		return fail(502, `Failed to reach robot: ${msgOf(e, 'unknown')}`);
	}
}

/** POST /runs — was the fill pages' startRun "Create the OT-2 run" block. */
async function runCreate(t: Ot2Transport, protocolId: unknown, rtp: unknown): Promise<VerbResult> {
	if (!protocolId || typeof protocolId !== 'string') return fail(400, 'protocolId required');
	if (rtp != null && (typeof rtp !== 'object' || Array.isArray(rtp))) return fail(400, 'runTimeParameterValues must be an object');
	const runTimeParameterValues = (rtp ?? {}) as Record<string, unknown>;
	try {
		const createRes = await t.post('/runs', {
			data: {
				protocolId,
				...(Object.keys(runTimeParameterValues).length ? { runTimeParameterValues } : {})
			}
		});
		if (!createRes.ok) {
			const body = await createRes.json().catch(() => ({}));
			const detail = (body as any).errors?.[0]?.detail ?? `Robot returned ${createRes.status}`;
			return { status: 502, body: { message: `Couldn't create run on robot: ${detail}`, robotStatus: createRes.status } };
		}
		const createBody = await createRes.json();
		const opentronsRunId = createBody?.data?.id;
		if (!opentronsRunId) return fail(502, 'Robot returned no run id');
		return ok({ opentronsRunId });
	} catch (err) {
		return fail(502, `Couldn't reach robot: ${err instanceof Error ? err.message : 'unknown'}`);
	}
}

/**
 * Stop a run — was stopRobotRun() in both fill pages. A run that is already
 * finished / cleared (404, 409, "not found|not allowed|terminal") counts as
 * stopped. Never fails: the operator's cancel must not be blocked by the robot;
 * a stop that can't be confirmed comes back as `warning` for the page to show.
 */
async function runStop(t: Ot2Transport, rid: unknown): Promise<VerbResult> {
	if (!rid || typeof rid !== 'string') return fail(400, 'rid required');
	try {
		const res = await t.post(`/runs/${rid}/actions`, { data: { actionType: 'stop' } });
		if (res.ok) return ok({ stopped: true, warning: null });
		const body = await res.json().catch(() => ({}));
		const detail = (body as any)?.errors?.[0]?.detail ?? `robot returned ${res.status}`;
		// Already finished/cleared → nothing to stop, treat as success.
		if (res.status === 404 || res.status === 409 || /not found|not allowed|terminal/i.test(String(detail))) {
			return ok({ stopped: false, alreadyTerminal: true, warning: null });
		}
		return ok({ stopped: false, warning: `Couldn't stop the run on the robot (${detail}) — confirm on the device.` });
	} catch (e) {
		return ok({
			stopped: false,
			warning: `Couldn't reach the robot to stop the run (${e instanceof Error ? e.message : 'unknown'}) — confirm on the device.`
		});
	}
}

/** Paging used by the finish parse (one big page) — recordRunFinished's request. */
export const FINISH_COMMANDS_PAGING = { pageLength: 10000, maxPages: 1 } as const;
/** Paging used by the wax filled-wells parse — cartsFilledPerRobotLog's loop. */
export const FILLED_WELLS_PAGING = { pageLength: 999, maxPages: 5 } as const;

/**
 * GET /runs/{id}/commands, paged exactly as the fill pages did: cursor 0, then
 * advance by the page's length until meta.totalLength or an empty page. A
 * non-OK page ends the read with what was collected (the old loops `break`).
 */
async function runCommands(t: Ot2Transport, rid: unknown, pageLengthArg: unknown, maxPagesArg: unknown): Promise<VerbResult> {
	if (!rid || typeof rid !== 'string') return fail(400, 'rid required');
	const pageLength =
		isFiniteNum(pageLengthArg) && pageLengthArg > 0 ? Math.min(10000, Math.floor(pageLengthArg)) : FINISH_COMMANDS_PAGING.pageLength;
	const maxPages = isFiniteNum(maxPagesArg) && maxPagesArg > 0 ? Math.min(10, Math.floor(maxPagesArg)) : FINISH_COMMANDS_PAGING.maxPages;
	const commands: RunCommand[] = [];
	let robotStatus: number | null = null;
	let cursor = 0;
	try {
		for (let page = 0; page < maxPages; page++) {
			const res = await t.get(`/runs/${rid}/commands?cursor=${cursor}&pageLength=${pageLength}`);
			if (!res.ok) {
				robotStatus = res.status;
				break;
			}
			const body = await res.json();
			const cmds = ((body as any)?.data ?? []) as RunCommand[];
			// Only what the parsers read: keeps the queue relay and the browser light.
			for (const c of cmds) commands.push({ commandType: c?.commandType, params: c?.params });
			const total = (body as any)?.meta?.totalLength ?? 0;
			cursor += cmds.length;
			if (cursor >= total || cmds.length === 0) break;
		}
	} catch (e) {
		return fail(502, `Failed to read run commands: ${msgOf(e, 'unknown')}`);
	}
	return ok({ commands, robotStatus });
}

/**
 * Tip tracker parse — was inline in both fill pages' recordRunFinished.
 * The protocol logs "TIP TRACKER: consumed tip A37 — next tip will be A38 (index 24)"
 * and "TIP TRACKER: starting from tip A37 (index 24)"; the LAST one wins.
 */
export function parseTipTracker(commands: RunCommand[]): { nextTipIndex: number | null; pickUpTipCount: number } {
	let nextTipIndex: number | null = null;
	let pickUpTipCount = 0;
	for (const cmd of commands ?? []) {
		if (cmd?.commandType === 'pickUpTip') pickUpTipCount += 1;
		if (cmd?.commandType === 'comment' && cmd.params?.message) {
			const m = String(cmd.params.message).match(/TIP TRACKER:[\s\S]*?\(index (\d+)\)/);
			if (m) nextTipIndex = parseInt(m[1], 10);
		}
	}
	return { nextTipIndex, pickUpTipCount };
}

/**
 * Wells the wax protocol reports it dispensed into ("Dispensed …uL into well X2"
 * comments), first-seen order, de-duplicated. Was the parse inside
 * cartsFilledPerRobotLog; the cart arithmetic is cartsFilledFromWells.
 */
export function parseFilledWells(commands: RunCommand[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const c of commands ?? []) {
		if (c?.commandType !== 'comment') continue;
		const m = c.params?.message?.match(/Dispensed [\d.]+uL into well ([A-X])(\d+)/);
		if (!m) continue;
		const well = m[1] + parseInt(m[2], 10);
		if (seen.has(well)) continue;
		seen.add(well);
		out.push(well);
	}
	return out;
}

/** A well token as parseFilledWells emits it. */
export const FILLED_WELL_RE = /^([A-X])(\d{1,2})$/;

/**
 * Which deck positions (1..24) the robot FINISHED: a cart counts only when every
 * well its row-pattern selection expects got a dispense (4 wax columns × the
 * active row patterns, default 3). Order = first cart seen, as before.
 */
export function cartsFilledFromWells(wells: string[], protocolParameters: Record<string, unknown> | null | undefined): number[] {
	const wellsPerCart = new Map<number, Set<string>>();
	for (const w of wells ?? []) {
		const m = FILLED_WELL_RE.exec(String(w));
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
	const pp = (protocolParameters ?? {}) as Record<string, unknown>;
	const patterns = ['row_pattern_0', 'row_pattern_1', 'row_pattern_2'].filter((k) => pp[k] !== false).length || 3;
	const expected = 4 * patterns;
	const filled: number[] = [];
	for (const [cart, ws] of wellsPerCart) if (ws.size >= expected) filled.push(cart);
	return filled;
}

/** loadName → wellName → {x,y,z}: the live Mongo geometry a run bundle must carry. */
export type ExpectedWells = Record<string, Record<string, { x?: number; y?: number; z?: number }>>;

const FRESH_TOL = 1e-6;

/**
 * Compare the labware definitions a protocol upload actually resolved (from its
 * on-robot analysis) against the expected (live Mongo) wells. Only loadNames in
 * `expected` are compared. Throws when the analysis can't be fetched. Moved
 * from protocol-freshness.ts bundledDefsMatchMongo.
 */
async function bundledDefsMatch(
	t: Ot2Transport,
	protocolId: string,
	expected: ExpectedWells,
	waitForCompletedMs = 0
): Promise<{ ok: boolean; detail: string }> {
	const deadline = Date.now() + waitForCompletedMs;
	let analysisId: string | null = null;
	for (;;) {
		const listRes = await t.get(`/protocols/${protocolId}/analyses`);
		if (!listRes.ok) throw new Error(`robot returned ${listRes.status} listing analyses`);
		const list = ((await listRes.json()) as any)?.data ?? [];
		const completed = list.filter((a: any) => a.status === 'completed');
		if (completed.length) {
			analysisId = completed[completed.length - 1].id;
			break;
		}
		if (list.some((a: any) => a.status === 'failed')) throw new Error('protocol analysis failed');
		if (Date.now() >= deadline) throw new Error('no completed analysis for protocol');
		await new Promise((r) => setTimeout(r, 3000));
	}
	const detRes = await t.get(`/protocols/${protocolId}/analyses/${analysisId}`);
	if (!detRes.ok) throw new Error(`robot returned ${detRes.status} fetching analysis`);
	const det = ((await detRes.json()) as any)?.data;
	if ((det?.errors ?? []).length) throw new Error('protocol analysis completed with errors');

	const has = (k: string) => Object.prototype.hasOwnProperty.call(expected, k);
	let checked = 0;
	for (const c of det?.commands ?? []) {
		if (c.commandType !== 'loadLabware') continue;
		const def = c.result?.definition;
		const loadName = def?.parameters?.loadName;
		if (!loadName || !has(loadName)) continue;
		const want = expected[loadName] ?? {};
		const got = def.wells ?? {};
		for (const wn of Object.keys(want)) {
			const w = want[wn] ?? {};
			const g = got[wn];
			if (!g) return { ok: false, detail: `${loadName} ${wn} missing from bundled def` };
			if (
				Math.abs((g.x ?? 0) - (w.x ?? 0)) > FRESH_TOL ||
				Math.abs((g.y ?? 0) - (w.y ?? 0)) > FRESH_TOL ||
				Math.abs((g.z ?? 0) - (w.z ?? 0)) > FRESH_TOL
			) {
				return { ok: false, detail: `${loadName} ${wn} bundled (${g.x},${g.y},${g.z}) != current (${w.x},${w.y},${w.z})` };
			}
		}
		checked++;
	}
	if (!checked) return { ok: false, detail: 'analysis resolved no BIMS-managed labware' };
	return { ok: true, detail: `${checked} BIMS labware defs verified current` };
}

/** 200 {ok, detail} when the comparison ran; 502 {message} when it couldn't. */
async function runEnsureFresh(t: Ot2Transport, args: Record<string, unknown>): Promise<VerbResult> {
	const protocolId = args.protocolId;
	if (!protocolId || typeof protocolId !== 'string') return fail(400, 'protocolId required');
	const expected = args.expectedWells;
	if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return fail(400, 'expectedWells required');
	const wait = isFiniteNum(args.waitForCompletedMs) ? Math.max(0, Math.min(180_000, args.waitForCompletedMs)) : 0;
	try {
		return ok(await bundledDefsMatch(t, protocolId, expected as ExpectedWells, wait));
	} catch (e) {
		return fail(502, msgOf(e, 'freshness check failed'));
	}
}

/** Normalized result of uploading + analyzing a protocol on a robot. */
export interface UploadedProtocolResult {
	opentronsProtocolId: string;
	analysisStatus: string;
	parametersSchema: unknown;
	labwareDefinitions: unknown;
	pipettesRequired: unknown;
	/** Analysis error details when analysisStatus is 'failed' (deploy records them). */
	analysisErrors?: string[];
}

/** What the server assembles for an upload: the .py + the BIMS labware it loads. */
export interface ProtocolUploadBundle {
	fileName: string;
	/** The .py as text (stored protocols, the browser) … */
	fileContent?: string;
	/** … or its exact bytes, base64 (an uploaded file, byte-for-byte). */
	fileB64?: string;
	labware: { fileName: string; json: string }[];
}

/**
 * A server transport that already did the upload AND the analysis wait (the
 * queue's `upload_protocol` bridge job) answers POST /protocols with this field;
 * the verb then skips its own analysis poll, so the queue path is unchanged.
 */
export const PRE_ANALYZED_FIELD = 'bimsUpload';

export const UPLOAD_POST_TIMEOUT_MS = 110_000;
const ANALYSIS_POLL_MS = 2000;
const ANALYSIS_BUDGET_MS = 60_000;

/** Pull params/labware/pipettes out of a robot analysis (handles both the
 *  inlined-result and detail-by-id shapes across robot-server versions). */
export function parseAnalysis(detail: any): Pick<UploadedProtocolResult, 'parametersSchema' | 'labwareDefinitions' | 'pipettesRequired'> {
	// runTimeParameters/labware/pipettes are top-level on the analysis; `result`
	// is a string verdict (e.g. "ok"), so only treat it as the body if it's an object.
	const body = detail?.result && typeof detail.result === 'object' ? detail.result : (detail ?? {});
	return {
		parametersSchema: body.runTimeParameters ?? null,
		labwareDefinitions: body.labware ?? null,
		pipettesRequired: body.pipettes ?? null
	};
}

function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** The multipart body the OT-2 wants: the .py first, then each labware JSON. */
export function buildProtocolForm(bundle: ProtocolUploadBundle): FormData {
	const form = new FormData();
	const py: BlobPart = bundle.fileB64 != null ? (b64ToBytes(bundle.fileB64) as BlobPart) : String(bundle.fileContent ?? '');
	form.append('files', new Blob([py], { type: 'text/x-python' }), bundle.fileName);
	// Bundle the BIMS labware library so the robot resolves custom labware.
	for (const lw of bundle.labware ?? []) {
		form.append('files', new Blob([lw.json], { type: 'application/json' }), lw.fileName);
	}
	return form;
}

/**
 * Multipart POST /protocols + wait for the analysis — the robot half of
 * proxy.ts robotUploadProtocol (was directUpload). The bundle is assembled by
 * the server (proxy.ts assembleProtocolUpload); only the transfer runs here.
 */
async function runUploadProtocol(t: Ot2Transport, args: Record<string, unknown>): Promise<VerbResult> {
	const fileName = args.fileName;
	if (!fileName || typeof fileName !== 'string') return fail(400, 'fileName required');
	if (typeof args.fileContent !== 'string' && typeof args.fileB64 !== 'string') return fail(400, 'fileContent or fileB64 required');
	const labware = Array.isArray(args.labware) ? (args.labware as any[]) : [];
	if (labware.some((l) => !l || typeof l.fileName !== 'string' || typeof l.json !== 'string')) {
		return fail(400, 'labware entries need fileName + json');
	}
	try {
		const form = buildProtocolForm({
			fileName,
			fileContent: typeof args.fileContent === 'string' ? args.fileContent : undefined,
			fileB64: typeof args.fileB64 === 'string' ? args.fileB64 : undefined,
			labware
		});
		const res = await t.post('/protocols', form, { timeoutMs: UPLOAD_POST_TIMEOUT_MS });
		if (!res.ok) throw new Error(`robot upload failed (${res.status})`);
		const posted = (await res.json()) as any;
		if (posted?.[PRE_ANALYZED_FIELD]) return ok(posted[PRE_ANALYZED_FIELD]);
		const pid = posted?.data?.id;
		if (!pid) throw new Error('robot did not return a protocol id');

		let analysisStatus = 'pending';
		let analysisErrors: string[] | undefined;
		let parsed: any = { parametersSchema: null, labwareDefinitions: null, pipettesRequired: null };
		const deadline = Date.now() + ANALYSIS_BUDGET_MS;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, ANALYSIS_POLL_MS));
			const ar = await t.get(`/protocols/${pid}/analyses`).catch(() => null);
			if (!ar || !ar.ok) continue;
			const analyses = ((await ar.json()) as any)?.data ?? [];
			if (!analyses.length) continue;
			const latest = analyses[analyses.length - 1];
			if (latest.status === 'completed') {
				let detail: any = latest;
				const dr = await t.get(`/protocols/${pid}/analyses/${latest.id}`).catch(() => null);
				if (dr && dr.ok) detail = ((await dr.json()) as any)?.data ?? latest;
				parsed = parseAnalysis(detail);
				analysisStatus = 'completed';
				break;
			}
			if (latest.status === 'failed') {
				analysisStatus = 'failed';
				analysisErrors = ((latest.errors ?? []) as any[]).map((e) => e?.detail ?? e?.errorType ?? 'Unknown');
				break;
			}
		}
		return ok({ opentronsProtocolId: pid, analysisStatus, ...parsed, ...(analysisErrors ? { analysisErrors } : {}) });
	} catch (e) {
		return fail(502, msgOf(e, 'Failed to upload protocol'));
	}
}

/** Generic maintenance command (LPC and other arbitrary commands, S10c). */
async function mxCommand(t: Ot2Transport, args: Record<string, unknown>): Promise<VerbResult> {
	const runId = args.runId;
	const commandType = args.commandType;
	if (!runId || typeof runId !== 'string') return fail(400, 'runId required');
	if (!commandType || typeof commandType !== 'string') return fail(400, 'commandType required');
	const params =
		args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? (args.params as Record<string, unknown>) : {};
	const timeoutMs = isFiniteNum(args.timeoutMs) && args.timeoutMs > 0 ? Math.min(120_000, args.timeoutMs) : undefined;
	try {
		const body = await sendMaintenanceCommand(t, runId, commandType, params, {
			waitUntilComplete: args.waitUntilComplete !== false,
			timeoutMs
		});
		return ok({ ok: true, command: body?.data ?? null });
	} catch (e) {
		return fail(502, msgOf(e, `Failed to run ${commandType}`));
	}
}

// ── two-phase run lifecycle sequences (OT2-TAILNET-5 §7.1) ─────────────────
//
// Each fill-page lifecycle action is "server prepare → robot half → server
// confirm". The ORDER of those steps lives here, once, for both lines:
//   queue line   the page's single server action runs the sequence with
//                verb = runVerb(serverTransport(robot)) and steps = direct calls
//   tailnet line the page runs the same sequence with verb = session.call and
//                steps = the ?/start… form actions
// A step returning {error} stops the sequence; its message is what the page shows.

export type Line = 'queue' | 'tailnet';
export type ProcessType = 'wax-filling' | 'reagent-filling';
export type StepError = { error: string; status?: number };
export const isStepError = (v: unknown): v is StepError => !!v && typeof (v as any).error === 'string';

/** A verb call as a sequence sees it. `lineLost` = the direct line dropped mid-call. */
export type SequenceVerb = (verb: Ot2Verb, args: Record<string, unknown>) => Promise<VerbResult & { lineLost?: boolean }>;

export type StartStepId = 'checking' | 'uploading' | 'verifying' | 'creating' | 'running';
export type StartStepStatus = 'active' | 'done' | 'failed' | 'skipped';

export interface StartPrepared {
	token: string;
	processType: ProcessType;
	/** The robot's CURRENT protocol entry (the posted id is never trusted). */
	protocolId: string | null;
	expectedWells: ExpectedWells;
	/** RTP values for protocolId's schema; null when there is no current entry. */
	runTimeParameterValues: Record<string, unknown> | null;
}

export type StartConfirmObs =
	| { phase: 'created'; opentronsRunId: string; protocolId: string }
	| { phase: 'played'; opentronsRunId: string }
	| { phase: 'failed'; stage: 'freshness' | 'create' | 'play'; message: string; opentronsRunId?: string; uncertain?: boolean };

export interface StartRunSteps {
	prepare(): Promise<StartPrepared | StepError>;
	/** The stored .py + labware bundle to re-sync with (only called when stale). */
	bundle(token: string, staleDetail: string): Promise<ProtocolUploadBundle | StepError>;
	/** Record the fresh upload on the robot doc; returns the RTP values for its schema. */
	recordResync(
		token: string,
		uploaded: UploadedProtocolResult,
		from: string | null,
		reason: string
	): Promise<{ runTimeParameterValues: Record<string, unknown> } | StepError>;
	confirm(token: string, obs: StartConfirmObs): Promise<Record<string, unknown> | StepError>;
	verb: SequenceVerb;
	onStep?(step: StartStepId, status: StartStepStatus, detail?: string): void;
}

export type SequenceResult =
	| { ok: true; opentronsRunId: string; result: Record<string, unknown> }
	| { ok: false; error: string; status: number };

const bodyMsg = (r: VerbResult, fallback: string) => {
	const b = (r.body ?? {}) as any;
	return typeof b.message === 'string' && b.message ? b.message : typeof b.detail === 'string' && b.detail ? b.detail : fallback;
};

/**
 * Start a fill run: freshness gate (auto-resync when stale), create, play. The
 * same steps, order and messages the fill pages' startRun had.
 */
export async function startRunSequence(s: StartRunSteps): Promise<SequenceResult> {
	const step = (id: StartStepId, st: StartStepStatus, d?: string) => s.onStep?.(id, st, d);
	const prepared = await s.prepare();
	if (isStepError(prepared)) return { ok: false, error: prepared.error, status: prepared.status ?? 400 };
	const { token, processType, expectedWells } = prepared;

	const failStart = async (obs: Extract<StartConfirmObs, { phase: 'failed' }>, status = 502): Promise<SequenceResult> => {
		await s.confirm(token, obs).catch(() => null);
		return { ok: false, error: obs.message, status };
	};
	const freshFail = (msg: string, at: StartStepId) => {
		step(at, 'failed', msg);
		return failStart({ phase: 'failed', stage: 'freshness', message: `Deck-calibration freshness check failed: ${msg}` });
	};

	// 1. Freshness: prove the robot's current bundle carries live calibration.
	step('checking', 'active');
	let protocolId = prepared.protocolId;
	let rtp = prepared.runTimeParameterValues;
	let staleDetail = 'no protocol entry on robot';
	let fresh = false;
	if (protocolId) {
		const r = await s.verb('run.ensureFresh', { protocolId, expectedWells });
		const b = (r.body ?? {}) as any;
		if (r.status === 200 && b.ok === true) fresh = true;
		else staleDetail = r.status === 200 ? String(b.detail) : `could not verify bundle: ${bodyMsg(r, 'unknown')}`;
	}
	if (fresh) {
		step('checking', 'done');
		step('uploading', 'skipped');
		step('verifying', 'skipped');
	} else {
		step('checking', 'done', `stale: ${staleDetail}`);
		// 2. Stale / unverifiable → re-upload the stored .py with the LIVE defs.
		step('uploading', 'active');
		const bundle = await s.bundle(token, staleDetail);
		if (isStepError(bundle)) return freshFail(bundle.error, 'uploading');
		const up = await s.verb('run.uploadProtocol', bundle as unknown as Record<string, unknown>);
		if (up.status !== 200) return freshFail(bodyMsg(up, 'upload failed'), 'uploading');
		const uploaded = up.body as UploadedProtocolResult;
		const rec = await s.recordResync(token, uploaded, protocolId, staleDetail);
		if (isStepError(rec)) return freshFail(rec.error, 'uploading');
		step('uploading', 'done');
		// Hard gate: prove the FRESH upload carries the live calibration.
		step('verifying', 'active');
		const v = await s.verb('run.ensureFresh', {
			protocolId: uploaded.opentronsProtocolId,
			expectedWells,
			waitForCompletedMs: 120_000
		});
		if (v.status !== 200) return freshFail(bodyMsg(v, 'verify failed'), 'verifying');
		if ((v.body as any)?.ok !== true) {
			return freshFail(`re-synced ${processType} protocol still doesn't match live calibration: ${(v.body as any)?.detail}`, 'verifying');
		}
		step('verifying', 'done');
		protocolId = uploaded.opentronsProtocolId;
		rtp = rec.runTimeParameterValues;
	}

	// 3. Create the OT-2 run.
	step('creating', 'active');
	const c = await s.verb('run.create', { protocolId, runTimeParameterValues: rtp ?? {} });
	const opentronsRunId = (c.body as any)?.opentronsRunId as string | undefined;
	if (c.status !== 200 || !opentronsRunId) {
		const message = bodyMsg(c, "Couldn't create run on robot");
		step('creating', 'failed', message);
		// The answer was lost but the POST may have landed: keep the start intent
		// so the page's reconcile finds (or rules out) the robot run.
		return failStart({ phase: 'failed', stage: 'create', message, uncertain: c.lineLost === true });
	}
	const created = await s.confirm(token, { phase: 'created', opentronsRunId, protocolId: protocolId as string });
	if (isStepError(created)) {
		step('creating', 'failed', created.error);
		return { ok: false, error: created.error, status: created.status ?? 502 };
	}
	step('creating', 'done');

	// 4. Start execution.
	step('running', 'active');
	const p = await s.verb('run.action', { rid: opentronsRunId, action: 'play' });
	if (p.status !== 200) {
		const b = (p.body ?? {}) as any;
		// A robot answer carries `detail`; a transport failure only a message.
		const message =
			typeof b.detail === 'string'
				? `Created run ${opentronsRunId} but couldn't start it: ${b.detail}${processType === 'wax-filling' ? '. Operator can play it from the device page.' : '.'}`
				: `Created run ${opentronsRunId} but couldn't start it: ${bodyMsg(p, 'unknown')}`;
		step('running', 'failed', message);
		return failStart({ phase: 'failed', stage: 'play', message, opentronsRunId });
	}
	const played = await s.confirm(token, { phase: 'played', opentronsRunId });
	if (isStepError(played)) {
		step('running', 'failed', played.error);
		return { ok: false, error: played.error, status: played.status ?? 502 };
	}
	step('running', 'done');
	return { ok: true, opentronsRunId, result: played };
}

/** What the finish confirm is told: the robot's final status + the tip parse. */
export interface FinishObservation {
	finalStatus: string;
	tips: { nextTipIndex: number | null; pickUpTipCount: number };
}

/**
 * Robot half of Finish: read the run's commands (one 10k page, as before) and
 * parse the tip tracker. A failed read yields the empty parse, exactly as the
 * old catch / `if (cmdRes.ok)` did.
 */
export async function observeRunFinished(verb: SequenceVerb, rid: string, finalStatus: string): Promise<FinishObservation> {
	const r = await verb('run.commands', { rid, ...FINISH_COMMANDS_PAGING });
	const commands = r.status === 200 ? (((r.body as any)?.commands ?? []) as RunCommand[]) : [];
	return { finalStatus: String(finalStatus ?? '').toLowerCase(), tips: parseTipTracker(commands) };
}

/** What the cancel/abort confirm is told. filledWells null = not read / read failed. */
export interface StopObservation {
	stopWarning: string | null;
	filledWells: string[] | null;
}

/**
 * Robot half of Cancel/Abort: stop the run (404/409/terminal = stopped), then,
 * for wax runs with carts, read which wells the robot finished.
 */
export async function observeRunStopped(verb: SequenceVerb, rid: string, opts: { readFilledWells: boolean }): Promise<StopObservation> {
	const st = await verb('run.stop', { rid });
	const b = (st.body ?? {}) as any;
	const stopWarning =
		st.status === 200
			? typeof b.warning === 'string'
				? b.warning
				: null
			: `Couldn't reach the robot to stop the run (${bodyMsg(st, 'unknown')}) — confirm on the device.`;
	let filledWells: string[] | null = null;
	if (opts.readFilledWells) {
		const r = await verb('run.commands', { rid, ...FILLED_WELLS_PAGING });
		if (r.status === 200) filledWells = parseFilledWells(((r.body as any)?.commands ?? []) as RunCommand[]);
	}
	return { stopWarning, filledWells };
}

// ── tailnet-line drivers (OT2-TAILNET-5 §7.1) ──────────────────────────────
//
// What a fill page runs when its robot session is on the direct line. They only
// wire the page's I/O (its form actions, its session) into the sequences above;
// the order, the verbs and the parsers are the same objects the queue line uses
// inside its single server action. No robot logic lives in a component.

/** Posts one of the page's form actions; resolves its data or its error. */
export type ActionPoster = (
	action: string,
	fields: Record<string, string>
) => Promise<{ ok: true; data: any } | { ok: false; error: string; status: number }>;

/** The part of a RobotSession ($lib/opentrons/direct-client) a driver needs. */
export interface VerbSession {
	call(verb: Ot2Verb, args: Record<string, unknown>, init?: { signal?: AbortSignal }): Promise<Response>;
	readonly state: { transport: string; fellBack?: boolean };
}

/** The line a confirm is stamped with: the session's line at that moment. */
export const lineOf = (s: VerbSession | null | undefined): Line => (s?.state.transport === 'direct' ? 'tailnet' : 'queue');

/**
 * A session's call() as a SequenceVerb. `lineLost` = this very call is what
 * dropped the direct line (the session answered a NO_RETRY verb with 502 and
 * did not repeat it), so the robot may have acted even though we have no answer.
 */
export function sessionVerb(session: VerbSession): SequenceVerb {
	return async (verb, args) => {
		const wasFallenBack = session.state.fellBack === true;
		const res = await session.call(verb, args);
		const body = await res.json().catch(() => ({}));
		return { status: res.status, body, lineLost: !wasFallenBack && session.state.fellBack === true };
	};
}

const stepErr = (r: { error: string; status: number }): StepError => ({ error: r.error, status: r.status });

/** FormData (the start panel's form) → the plain string fields an action takes. */
export function formFields(fd: FormData | Record<string, string>): Record<string, string> {
	if (typeof FormData !== 'undefined' && fd instanceof FormData) {
		const out: Record<string, string> = {};
		for (const [k, v] of fd.entries()) if (typeof v === 'string') out[k] = v;
		return out;
	}
	return { ...(fd as Record<string, string>) };
}

/**
 * Start over the session: ?/startPrepare → run.ensureFresh (→ ?/startBundle →
 * run.uploadProtocol → ?/startRecordResync → run.ensureFresh verify) →
 * run.create → ?/startConfirm(created) → run.action play → ?/startConfirm(played).
 * Every server call is short; the long upload + analysis wait run on the robot line.
 *
 * `bridge` (the session's daemon client, RobotSession.bridge()): when set, the
 * confirms say so (`bridgeJobs: '1'`) and a tailnet `played` confirm returns an
 * `auto_resume_run` job INSTEAD of enqueueing a queue command; it is submitted
 * here fire-and-forget — never awaited, never retried, never failing the start.
 * Without it the confirm enqueues the queue command exactly as before.
 */
export async function startRunTwoPhase(o: {
	form: FormData | Record<string, string>;
	post: ActionPoster;
	session: VerbSession;
	onStep?: StartRunSteps['onStep'];
	bridge?: BridgeClient | null;
}): Promise<SequenceResult> {
	const form = formFields(o.form);
	const runId = form.runId ?? '';
	const line = lineOf(o.session);
	const bridge = o.bridge ?? null;
	const r = await startRunSequence({
		prepare: async () => {
			const r = await o.post('startPrepare', { ...form, line });
			return r.ok ? (r.data as StartPrepared) : stepErr(r);
		},
		bundle: async (token, staleDetail) => {
			const r = await o.post('startBundle', { runId, token, staleDetail });
			return r.ok ? (r.data?.bundle as ProtocolUploadBundle) : stepErr(r);
		},
		recordResync: async (token, uploaded, from, reason) => {
			const r = await o.post('startRecordResync', {
				...form,
				token,
				uploaded: JSON.stringify(uploaded),
				from: from ?? '',
				reason,
				line
			});
			return r.ok ? { runTimeParameterValues: (r.data?.runTimeParameterValues ?? {}) as Record<string, unknown> } : stepErr(r);
		},
		confirm: async (token, obs) => {
			const r = await o.post('startConfirm', { runId, token, obs: JSON.stringify(obs), line, ...(bridge ? { bridgeJobs: '1' } : {}) });
			return r.ok ? ((r.data ?? {}) as Record<string, unknown>) : stepErr(r);
		},
		verb: sessionVerb(o.session),
		onStep: o.onStep
	});
	if (r.ok && bridge && r.result?.job) void submitAutoResume(bridge, r.result.job);
	return r;
}

/** Finish over the session: run.commands + the tip parse, then ?/finishConfirm. */
export async function finishRunTwoPhase(o: {
	runId: string;
	rid: string;
	finalStatus: string;
	post: ActionPoster;
	session: VerbSession;
}) {
	const line = lineOf(o.session);
	const obs = await observeRunFinished(sessionVerb(o.session), o.rid, o.finalStatus);
	return o.post('finishConfirm', { runId: o.runId, finalStatus: obs.finalStatus, tips: JSON.stringify(obs.tips), line });
}

/**
 * Cancel / abort over the session: run.stop (+ the wax filled-wells read), then
 * ?/cancelConfirm | ?/abortConfirm with the observation. `fields` = the page's
 * own form fields (reason, photoUrl, …), passed through unchanged.
 */
export async function stopRunTwoPhase(o: {
	action: 'cancel' | 'abort';
	runId: string;
	rid: string | null;
	readFilledWells: boolean;
	fields?: Record<string, string>;
	post: ActionPoster;
	session: VerbSession;
}) {
	const line = lineOf(o.session);
	const obs: StopObservation = o.rid
		? await observeRunStopped(sessionVerb(o.session), o.rid, { readFilledWells: o.readFilledWells })
		: { stopWarning: null, filledWells: null };
	return o.post(o.action === 'cancel' ? 'cancelConfirm' : 'abortConfirm', {
		...(o.fields ?? {}),
		runId: o.runId,
		stopWarning: obs.stopWarning ?? '',
		filledWells: JSON.stringify(obs.filledWells),
		line
	});
}

/** Run one assembled upload over a verb line; the uploaded protocol or its error. */
export async function uploadBundle(verb: SequenceVerb, bundle: ProtocolUploadBundle): Promise<UploadedProtocolResult | StepError> {
	const r = await verb('run.uploadProtocol', bundle as unknown as Record<string, unknown>);
	if (r.status !== 200) return { error: bodyMsg(r, 'Failed to upload protocol'), status: r.status };
	return r.body as UploadedProtocolResult;
}

/**
 * The shape a browser-reported upload result must have before a server records
 * it (confirm halves of S4). Null when malformed.
 */
export function validUploadedResult(v: unknown): UploadedProtocolResult | null {
	const u = v as any;
	if (!u || typeof u !== 'object') return null;
	if (typeof u.opentronsProtocolId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(u.opentronsProtocolId)) return null;
	if (typeof u.analysisStatus !== 'string' || u.analysisStatus.length > 40) return null;
	if (u.parametersSchema != null && !Array.isArray(u.parametersSchema)) return null;
	if (u.analysisErrors != null && (!Array.isArray(u.analysisErrors) || u.analysisErrors.some((e: unknown) => typeof e !== 'string'))) return null;
	return {
		opentronsProtocolId: u.opentronsProtocolId,
		analysisStatus: u.analysisStatus,
		parametersSchema: u.parametersSchema ?? null,
		labwareDefinitions: u.labwareDefinitions ?? null,
		pipettesRequired: u.pipettesRequired ?? null,
		...(Array.isArray(u.analysisErrors) ? { analysisErrors: (u.analysisErrors as string[]).slice(0, 50) } : {})
	};
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
			isFormData(body)
				? // Multipart (protocol upload): no JSON content-type — the browser sets
					// the multipart boundary itself. Same `opentrons-version: *` the
					// server's direct upload always sent.
					fetchImpl(`${base}${path}`, {
						method: 'POST',
						headers: { 'opentrons-version': '*' },
						body,
						signal: signalFor(opts?.timeoutMs)
					})
				: fetchImpl(`${base}${path}`, {
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
