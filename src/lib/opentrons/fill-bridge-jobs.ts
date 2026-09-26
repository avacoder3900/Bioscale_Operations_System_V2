/**
 * The fill pages' daemon jobs on the TAILNET line (OT2-TAILNET-5 §7.3, S6).
 *
 * One place for the browser half of every daemon job the wax- and
 * reagent-filling flows start: the cartridge sweep, the deck-barcode scan, the
 * mid-run tip swap and the robot-server restart. The two DeckLoadingGrids, the
 * wax page's scan-and-start orchestration, both fill pages and both fill
 * layouts call these; no job logic lives in a component.
 *
 * Every job has the same shape:
 *
 *   1. server PREPARE (`line: 'tailnet'`) — the BIMS rows are written first
 *      (SweepRun + AuditLog, tip-swap AuditLog, restart AuditLog) and the route
 *      answers the job descriptor `{jobId, kind, payload}`; no queue row;
 *   2. bridge.submit(job) — ONCE. A failed submit is never retried and never
 *      re-sent over the queue (the job could run twice); the prepared row is
 *      marked abandoned through the same route and the error surfaces;
 *   3. live progress from /bridge/jobs/:id (no Vercel hop), reattaching through
 *      the BIMS report rows when the bridge stops answering (§7.5);
 *   4. server RECORD — the deck scan's tailnet confirm; a sweep's rows are
 *      written by the daemon itself (/api/agent/ot2/jobs/<jobId>/progress).
 *
 * The QUEUE line never comes here: a caller with `session.bridge() === null`
 * runs its existing fetches unchanged. Isomorphic (no DOM, no Svelte, no
 * $lib/server); every I/O is injectable for the unit tests.
 */
import { BridgeError, type BridgeClient, type BridgeJob, type BridgeJobDescriptor, type BridgeJobKind } from './bridge-client';
import type { ActionPoster } from './ot2-protocol';

export interface FillJobDeps {
	/** Same-origin BIMS fetch (defaults to globalThis.fetch). */
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	sleep?: (ms: number) => Promise<void>;
	nowMs?: () => number;
}

export type JobFail = { ok: false; error: string; status?: number };

const bimsFetchOf = (d?: FillJobDeps) => d?.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
const sleepOf = (d?: FillJobDeps) => d?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
const nowOf = (d?: FillJobDeps) => d?.nowMs ?? (() => Date.now());

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function postJson(deps: FillJobDeps | undefined, url: string, body: unknown): Promise<Response> {
	return bimsFetchOf(deps)(url, {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
}

/** The message a grid shows for a failed BIMS route: SvelteKit `{message}`, a json `{error}`, else the status. */
export async function routeError(res: Response, fallback: string): Promise<string> {
	const body = (await res.json().catch(() => ({}))) as any;
	return String(body?.message ?? body?.error ?? `${fallback} (HTTP ${res.status})`);
}

const JOB_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** A prepare route's `job`, shape-checked, for exactly the kind the caller asked for. */
export function validJobDescriptor(v: unknown, kind: BridgeJobKind): (BridgeJobDescriptor & { jobId: string }) | null {
	const j = v as any;
	if (!j || typeof j !== 'object' || j.kind !== kind) return null;
	if (typeof j.jobId !== 'string' || !JOB_ID_RE.test(j.jobId)) return null;
	if (!j.payload || typeof j.payload !== 'object' || Array.isArray(j.payload)) return null;
	return { jobId: j.jobId, kind, payload: j.payload as Record<string, unknown> };
}

/**
 * Submit a prepared job ONCE. On failure `onSubmitFailed` marks the prepared
 * BIMS row abandoned (its own errors are logged, never thrown) and the error is
 * returned — no retry, no queue re-submit.
 */
export async function submitPreparedJob(
	bridge: BridgeClient,
	job: BridgeJobDescriptor & { jobId: string },
	what: string,
	onSubmitFailed?: (message: string) => Promise<unknown>
): Promise<{ ok: true; jobId: string; position: number | null; duplicate: boolean } | JobFail> {
	try {
		const r = await bridge.submit(job);
		return { ok: true, jobId: r.jobId, position: r.position, duplicate: r.duplicate };
	} catch (e) {
		// No answer ('network') does not mean it did not land: ask for the job by
		// the id we sent (a read, not a re-submit) before calling it failed.
		if (e instanceof BridgeError && e.code === 'network') {
			try {
				const landed = await bridge.getJob(job.jobId);
				if (landed?.jobId === job.jobId) {
					return { ok: true, jobId: landed.jobId, position: landed.queuePosition ?? null, duplicate: true };
				}
			} catch {
				// still nothing — fall through to the failure
			}
		}
		const message = `Couldn't hand the ${what} to the robot over Tailscale: ${errText(e)}`;
		if (onSubmitFailed) {
			await onSubmitFailed(message).catch((err) => console.warn(`[fill-bridge-jobs] could not mark the ${what} abandoned:`, errText(err)));
		}
		return { ok: false, error: message, status: e instanceof BridgeError ? e.status : undefined };
	}
}

// ── sweep ──────────────────────────────────────────────────────────────────

export type SweepStatus = 'running' | 'paused' | 'cancelled' | 'completed' | 'errored';
export const TERMINAL_SWEEP: readonly SweepStatus[] = ['completed', 'cancelled', 'errored'];

/** The GET /api/scanner/sweep/<id> snapshot fields the fill UIs read. */
export interface SweepSnapshot {
	_id: string;
	status: SweepStatus;
	slotsTotal: number;
	slotsDone: number;
	currentSlotIndex: number | null;
	scans: Array<{ slotIndex: number; barcode: string; rawPayload?: string | null; [k: string]: unknown }>;
	errors: Array<{ slotIndex: number; message: string; [k: string]: unknown }>;
	log: Array<{ ts: string; level: 'info' | 'warn' | 'error'; message: string; slotIndex?: number | null }>;
	abortReason?: string | null;
	pauseRequested?: boolean;
	cancelRequested?: boolean;
	line?: string;
	bridgeJobId?: string;
}

export interface SweepRequest {
	robotId: string;
	source: 'wax_filling' | 'reagent_filling' | 'manual' | 'test';
	contextRef?: string;
	maxSlots?: number;
	slotIndices?: number[];
}

export type SweepStarted = { ok: true; sweepRunId: string; jobId: string; slotsTotal: number | null };

/**
 * Sweep, tailnet line: POST /api/scanner/sweep {line:'tailnet'} (the SweepRun
 * + AuditLog 'sweep_enqueued' are written there), then submit the job. A failed
 * submit closes the prepared SweepRun through `action: 'abandon'`.
 */
export async function startSweepOverBridge(
	bridge: BridgeClient,
	req: SweepRequest,
	opts: { failLabel?: string } = {},
	deps?: FillJobDeps
): Promise<SweepStarted | JobFail> {
	const failLabel = opts.failLabel ?? 'Sweep failed';
	let res: Response;
	try {
		res = await postJson(deps, '/api/scanner/sweep', { ...req, line: 'tailnet' });
	} catch (e) {
		return { ok: false, error: errText(e) };
	}
	if (!res.ok) return { ok: false, error: await routeError(res, failLabel), status: res.status };
	const body = (await res.json().catch(() => ({}))) as any;
	const sweepRunId = typeof body?.sweepRunId === 'string' ? body.sweepRunId : '';
	const job = validJobDescriptor(body?.job, 'sweep');
	if (!sweepRunId || !job) return { ok: false, error: 'BIMS did not return a sweep job for the tailnet line — reload the page.' };
	const sub = await submitPreparedJob(bridge, job, 'sweep', async (message) => {
		const a = await postJson(deps, `/api/scanner/sweep/${encodeURIComponent(sweepRunId)}`, {
			action: 'abandon',
			line: 'tailnet',
			jobId: job.jobId,
			error: message
		});
		if (!a.ok) throw new Error(await routeError(a, 'abandon failed'));
	});
	if (!sub.ok) return sub;
	return { ok: true, sweepRunId, jobId: job.jobId, slotsTotal: typeof body.slotsTotal === 'number' ? body.slotsTotal : null };
}

const LEVELS = new Set(['info', 'warn', 'error']);

/**
 * A /bridge sweep job as the snapshot the UIs already render. The daemon posts
 * the SAME progress bodies to BIMS, so this is the BIMS row minus the Vercel hop.
 * The daemon never reports 'paused' (neither line does): the status stays
 * 'running' until a terminal `final`, exactly as the SweepRun does.
 */
export function snapshotFromJob(job: BridgeJob, sweepRunId: string, slotsTotal: number): SweepSnapshot {
	const p = job.progress ?? ({} as BridgeJob['progress']);
	const final = p.final ?? null;
	let status: SweepStatus = 'running';
	let abortReason: string | null = null;
	if (final && (TERMINAL_SWEEP as readonly string[]).includes(final.status)) {
		status = final.status as SweepStatus;
		abortReason = final.abortReason ?? null;
	} else if (job.status === 'completed') {
		const reported = (job.result as any)?.status;
		status = (TERMINAL_SWEEP as readonly string[]).includes(reported) ? reported : 'completed';
	} else if (job.status === 'cancelled') {
		status = 'cancelled';
		abortReason = 'cancelled by operator';
	} else if (job.status === 'failed') {
		status = 'errored';
		abortReason = job.error ?? 'Sweep failed on the robot';
	}
	if (!abortReason && status === 'errored' && job.error) abortReason = job.error;
	return {
		_id: sweepRunId,
		status,
		slotsTotal,
		slotsDone: typeof p.slotsDone === 'number' ? p.slotsDone : 0,
		currentSlotIndex: typeof p.currentSlotIndex === 'number' ? p.currentSlotIndex : null,
		scans: (p.scans ?? [])
			.filter((s: any) => typeof s?.slotIndex === 'number')
			.map((s: any) => ({ ...s, slotIndex: s.slotIndex, barcode: String(s.barcode ?? ''), rawPayload: s.rawPayload ?? null })),
		errors: (p.slotErrors ?? [])
			.filter((e: any) => typeof e?.slotIndex === 'number')
			.map((e: any) => ({ ...e, slotIndex: e.slotIndex, message: String(e.message ?? 'scan failed') })),
		log: (p.log ?? []).map((l) => ({
			ts: new Date((typeof l.ts === 'number' ? l.ts : 0) * 1000).toISOString(),
			level: (LEVELS.has(l.level) ? l.level : 'info') as 'info' | 'warn' | 'error',
			message: String(l.message ?? '')
		})),
		abortReason,
		pauseRequested: !!job.pauseRequested,
		cancelRequested: !!job.cancelRequested,
		line: 'tailnet',
		bridgeJobId: job.jobId
	};
}

export type SweepFollowResult =
	| { ok: true; snapshot: SweepSnapshot; source: 'bridge' | 'bims' }
	| { ok: false; error: string; snapshot: SweepSnapshot | null; timedOut?: boolean };

/**
 * Follow a tailnet sweep to its end. Reads /bridge/jobs/<jobId> every
 * `intervalMs`; `onSnapshot` gets each snapshot and returns true once it has
 * handled a terminal one. When the bridge stops answering (tailnet dropped,
 * daemon restarted, token refused) the job is still running on the robot and
 * still reporting to BIMS, so the follow reattaches to GET
 * /api/scanner/sweep/<id> — the same rows the queue line polls.
 */
export async function followSweep(
	o: {
		bridge: BridgeClient;
		sweepRunId: string;
		jobId: string;
		slotsTotal: number;
		onSnapshot: (s: SweepSnapshot) => boolean | Promise<boolean>;
		intervalMs?: number;
		timeoutMs?: number;
		/** Consecutive dropped bridge polls tolerated before reattaching to BIMS. */
		maxMisses?: number;
		signal?: AbortSignal;
	},
	deps?: FillJobDeps
): Promise<SweepFollowResult> {
	const sleep = sleepOf(deps);
	const now = nowOf(deps);
	const intervalMs = o.intervalMs ?? 500;
	const maxMisses = o.maxMisses ?? 3;
	const t0 = now();
	let last: SweepSnapshot | null = null;
	let source: 'bridge' | 'bims' = 'bridge';
	let misses = 0;
	for (;;) {
		if (o.signal?.aborted) return { ok: false, error: 'Stopped following the sweep', snapshot: last };
		let snap: SweepSnapshot | null = null;
		if (source === 'bridge') {
			try {
				snap = snapshotFromJob(await o.bridge.getJob(o.jobId), o.sweepRunId, o.slotsTotal);
				misses = 0;
				if (snap.cancelRequested && !(TERMINAL_SWEEP as readonly string[]).includes(snap.status)) {
					// Cancelled: BIMS terminal-izes the SweepRun at once (the queue
					// line's UI shows 'cancelled' immediately), while the daemon job
					// only ends at its next checkpoint — or never, if its worker is
					// wedged in a motion call. Follow the BIMS row from here on.
					source = 'bims';
					continue;
				}
			} catch (e) {
				const transient = e instanceof BridgeError && e.code === 'network';
				if (!transient || ++misses > maxMisses) {
					console.warn(`[fill-bridge-jobs] bridge stopped answering for sweep job ${o.jobId} — following the BIMS rows:`, errText(e));
					source = 'bims';
					continue;
				}
			}
		} else {
			let res: Response;
			try {
				res = await bimsFetchOf(deps)(`/api/scanner/sweep/${encodeURIComponent(o.sweepRunId)}`, { credentials: 'same-origin' });
			} catch (e) {
				return { ok: false, error: errText(e) || 'Live status poll failed', snapshot: last };
			}
			if (!res.ok) return { ok: false, error: `Live status poll failed (HTTP ${res.status})`, snapshot: last };
			snap = (await res.json()) as SweepSnapshot;
		}
		if (snap) {
			last = snap;
			if (await o.onSnapshot(snap)) return { ok: true, snapshot: snap, source };
		}
		if (o.timeoutMs && now() - t0 > o.timeoutMs) {
			return { ok: false, error: 'Timed out following the sweep', snapshot: last, timedOut: true };
		}
		await sleep(intervalMs);
	}
}

/**
 * Pause / resume / cancel a tailnet sweep. Both the daemon's job (immediate,
 * no Vercel hop) and the SweepRun flags (the durable record, what another tab
 * or a reattach reads, and what the daemon also honours on its next report)
 * are set:
 *   pause   bridge, then BIMS — either one pauses the walk;
 *   resume  BIMS first (the daemon ORs the BIMS flag), then bridge — both must clear;
 *   cancel  bridge, then BIMS — either one stops it; BIMS terminal-izes the run.
 * A 409 from either side means "already finished" and is not an error.
 */
export async function controlSweepOverBridge(
	bridge: BridgeClient,
	sweepRunId: string,
	jobId: string,
	action: 'pause' | 'resume' | 'cancel',
	deps?: FillJobDeps
): Promise<{ ok: true } | JobFail> {
	const viaBridge = async (): Promise<string | null> => {
		try {
			await bridge.control(jobId, action);
			return null;
		} catch (e) {
			if (e instanceof BridgeError && e.code === 'conflict') return null;
			return errText(e);
		}
	};
	const viaBims = async (): Promise<string | null> => {
		try {
			const r = await postJson(deps, `/api/scanner/sweep/${encodeURIComponent(sweepRunId)}`, { action });
			if (r.ok || r.status === 409) return null;
			const b = (await r.json().catch(() => ({}))) as any;
			return String(b?.message ?? `Control "${action}" failed (HTTP ${r.status})`);
		} catch (e) {
			return errText(e) || `Control "${action}" failed`;
		}
	};
	if (action === 'resume') {
		const bims = await viaBims();
		if (bims) return { ok: false, error: bims };
		const br = await viaBridge();
		return br ? { ok: false, error: `Resume did not reach the robot over Tailscale: ${br}` } : { ok: true };
	}
	const br = await viaBridge();
	const bims = await viaBims();
	if (br && bims) return { ok: false, error: bims };
	if (br) console.warn(`[fill-bridge-jobs] ${action} over the bridge failed (BIMS flag set instead):`, br);
	if (bims) console.warn(`[fill-bridge-jobs] ${action} recorded on the robot but not in BIMS:`, bims);
	return { ok: true };
}

// ── deck scan ──────────────────────────────────────────────────────────────

/**
 * Deck-barcode scan, tailnet line: prepare (guards, no row) → submit → poll
 * the job → POST /api/scanner/deck-scan {phase:'confirm', jobId, status,
 * result, error}, which runs the queue line's completion half (deck QR alias →
 * canonical id, AuditLog 'deck_scan' stamped line:'tailnet') and answers the
 * same {barcode} / 502.
 */
export async function deckScanOverBridge(
	bridge: BridgeClient,
	robotId: string,
	opts: { timeoutMs?: number; intervalMs?: number } = {},
	deps?: FillJobDeps
): Promise<{ ok: true; barcode: string } | JobFail> {
	const failLabel = 'Deck scan failed';
	let res: Response;
	try {
		res = await postJson(deps, '/api/scanner/deck-scan', { robotId, line: 'tailnet' });
	} catch (e) {
		return { ok: false, error: errText(e) };
	}
	if (!res.ok) return { ok: false, error: await routeError(res, failLabel), status: res.status };
	const job = validJobDescriptor(((await res.json().catch(() => ({}))) as any)?.job, 'deck_scan');
	if (!job) return { ok: false, error: 'BIMS did not return a deck-scan job for the tailnet line — reload the page.' };
	// The prepare wrote nothing, so a failed submit has nothing to abandon.
	const sub = await submitPreparedJob(bridge, job, 'deck scan');
	if (!sub.ok) return sub;
	let final: BridgeJob;
	try {
		final = await bridge.pollJob(job.jobId, undefined, {
			intervalMs: opts.intervalMs ?? 500,
			timeoutMs: opts.timeoutMs ?? 120_000
		});
	} catch (e) {
		return { ok: false, error: `The deck scan did not finish over Tailscale: ${errText(e)}` };
	}
	let conf: Response;
	try {
		conf = await postJson(deps, '/api/scanner/deck-scan', {
			robotId,
			line: 'tailnet',
			phase: 'confirm',
			jobId: job.jobId,
			status: final.status,
			result: final.result ?? null,
			error: final.error ?? null
		});
	} catch (e) {
		return { ok: false, error: errText(e) };
	}
	const body = (await conf.json().catch(() => ({}))) as any;
	if (!conf.ok || typeof body?.barcode !== 'string' || !body.barcode) {
		return { ok: false, error: String(body?.message ?? body?.error ?? `${failLabel} (HTTP ${conf.status})`), status: conf.status };
	}
	return { ok: true, barcode: body.barcode };
}

// ── tip swap ───────────────────────────────────────────────────────────────

/**
 * Mid-run tip swap, tailnet line: ?/requestTipSwap {line:'tailnet'} writes the
 * same AuditLog as the queue line (stamped line + bridgeJobId) and returns the
 * job; submit it. Accepted by the daemon = requested, the same point the queue
 * line reports success at (the command was enqueued). A failed submit posts
 * {phase:'abandon'} so the audit trail says the request never reached the robot.
 */
export async function tipSwapOverBridge(
	bridge: BridgeClient,
	post: ActionPoster,
	fields: { runId: string; mode: string; cancel: string }
): Promise<{ ok: true; jobId: string } | JobFail> {
	const r = await post('requestTipSwap', { ...fields, line: 'tailnet' });
	if (!r.ok) return { ok: false, error: r.error, status: r.status };
	const job = validJobDescriptor(r.data?.job, 'tip_swap_request');
	if (!job) return { ok: false, error: 'BIMS did not return a tip-swap job for the tailnet line — reload the page.' };
	const sub = await submitPreparedJob(bridge, job, 'tip-swap request', async (message) => {
		const a = await post('requestTipSwap', { runId: fields.runId, line: 'tailnet', phase: 'abandon', bridgeJobId: job.jobId, error: message });
		if (!a.ok) throw new Error(a.error);
	});
	return sub.ok ? { ok: true, jobId: job.jobId } : sub;
}

// ── robot-server restart ───────────────────────────────────────────────────

/**
 * Robot-server restart, tailnet line: POST restart-server {line:'tailnet'}
 * (AuditLog 'restart_robot_server' stamped line + bridgeJobId) → submit. The
 * daemon's restart-storm guard runs unchanged. A failed submit posts
 * {phase:'abandon'} (AuditLog 'restart_robot_server_submit_failed').
 */
export async function restartServerOverBridge(
	bridge: BridgeClient,
	robotId: string,
	deps?: FillJobDeps
): Promise<{ ok: true; message: string } | JobFail> {
	const url = `/api/opentrons-lab/robots/${encodeURIComponent(robotId)}/restart-server`;
	let res: Response;
	try {
		res = await postJson(deps, url, { line: 'tailnet' });
	} catch (e) {
		return { ok: false, error: errText(e) };
	}
	if (!res.ok) return { ok: false, error: await routeError(res, 'Restart failed'), status: res.status };
	const job = validJobDescriptor(((await res.json().catch(() => ({}))) as any)?.job, 'restart_robot_server');
	if (!job) return { ok: false, error: 'BIMS did not return a restart job for the tailnet line — reload the page.' };
	const sub = await submitPreparedJob(bridge, job, 'restart', async (message) => {
		const a = await postJson(deps, url, { line: 'tailnet', phase: 'abandon', jobId: job.jobId, error: message });
		if (!a.ok) throw new Error(await routeError(a, 'abandon failed'));
	});
	if (!sub.ok) return sub;
	return {
		ok: true,
		message:
			sub.position && sub.position > 0
				? `Restart sent over Tailscale — queued behind ${sub.position} daemon job(s); the robot server will be back ~90s after it runs. Watch the health badge.`
				: 'Restart sent over Tailscale — the robot server will be back in ~90s. Watch the health badge.'
	};
}

// ── auto-resume after a tailnet start ──────────────────────────────────────

/**
 * Fire-and-forget: submit the auto_resume_run job a tailnet start confirm
 * returned. Never awaited by the start, never retried, never failing it; a
 * failure is logged (the browser-side resume window in EmbeddedRunController
 * still covers an operator who stays on the page).
 */
export function submitAutoResume(bridge: BridgeClient, rawJob: unknown): Promise<void> {
	const job = validJobDescriptor(rawJob, 'auto_resume_run');
	if (!job) return Promise.resolve();
	return Promise.resolve()
		.then(() => bridge.submit(job))
		.then(
			() => undefined,
			(e) => console.warn('[fill-bridge-jobs] auto_resume_run was not accepted by the robot:', errText(e))
		);
}

