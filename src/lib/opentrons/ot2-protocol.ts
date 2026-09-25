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
}

/** Exactly the HTTP status + JSON body the equivalent BIMS API route returns. */
export type VerbResult = { status: number; body: unknown };

export type Ot2Verb =
	| 'run.get'
	| 'run.action'
	| 'mx.jog'
	| 'mx.position'
	| 'mx.moveTo'
	| 'mx.moveToWell'
	| 'mx.home'
	| 'mx.dropTip';

/** Verbs that move the gantry — deferred to the queue while a daemon job runs. */
export const MOTION_VERBS: ReadonlySet<Ot2Verb> = new Set([
	'mx.jog',
	'mx.moveTo',
	'mx.moveToWell',
	'mx.home',
	'mx.dropTip'
]);

/** BIMS API route path for a verb (relative to /api/opentrons-lab/robots/:id). */
export function verbRoute(verb: Ot2Verb, args: Record<string, unknown>): { method: 'GET' | 'POST'; path: string } {
	const rid = encodeURIComponent(String(args.rid ?? ''));
	const mr = encodeURIComponent(String(args.runId ?? ''));
	switch (verb) {
		case 'run.get':
			return { method: 'GET', path: `/runs/${rid}` };
		case 'run.action':
			return { method: 'POST', path: `/runs/${rid}/actions` };
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

	const runId = String(args.runId);
	const pipetteId = args.pipetteId;

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
			})
	};
}
