/**
 * BIMS → OT-2 through the arm Pi's cable link (2026-11-06).
 *
 * The arm Pi and the OT-2 share a USB-B cable (a USB Ethernet link, ~2 ms).
 * The Pi's /ot2/* routes (services/robot-arm/src/server/ot2_link.py) forward
 * requests to the robot's HTTP API over it, long-poll the run's pause state,
 * and hold the loop's next instruction for the stage protocol to fetch over
 * the same cable. For the wax-fill loop that turns a hop of 0.8-3 s through
 * the robot's Mongo command queue into one HTTPS call to the Pi.
 *
 * Every helper here returns null (or falls back to the queue) when the link
 * cannot be used: the Setup switch is off, the Pi is unreachable, no path to
 * the robot is up, or the robot on the cable is not the robot asked for. The
 * queue line stays exactly as it was, so a loop never depends on the cable.
 *
 * Each hop through the Pi that matters (every non-GET, every long-poll,
 * every failure) is a Movement Log row with device 'link', so the timing of
 * the handshake is visible beside the arm's and the OT-2's.
 */
import { connectDB } from './db/connection';
import { ArmWaxFillSettings, RobotArmMove } from './db/models';
import { robotArmFetchRaw } from './robot-arm-client';
import { robotDelete, robotGet, robotPost } from './opentrons/proxy';

export type ArmLinkMethod = 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';

export interface ArmLinkPath {
	addr: string | null;
	up: boolean;
	rtt_ms: number | null;
	error: string | null;
	iface?: string;
	carrier?: boolean;
}

export interface ArmLinkStatus {
	active: 'cable' | 'lan' | null;
	cable: ArmLinkPath;
	lan: ArmLinkPath;
	robot: { name: string | null; serial: string | null };
	/** The Pi's own addresses: what the protocol must call. */
	self: { cable: string | null; lan: string | null };
	port: number;
	/** The OT-2's bridge daemon (1.7.0, ARM_PI_URLS) saying hello over the cable: the barcode can come this way. */
	scanner?: { version: string | null; at: number; age_s: number; fresh: boolean } | null;
}

export interface ArmLinkView {
	/** The link is usable for the arm line's robot right now. */
	usable: boolean;
	/** Why not, in one line; null when usable. */
	reason: string | null;
	/** Setup's switch. */
	enabled: boolean;
	status: ArmLinkStatus | null;
	checkedAt: string;
}

const CACHE_MS = 20_000;
const DOWN_MS = 20_000;
let cache: { at: number; status: ArmLinkStatus | null; error: string | null } | null = null;

/** GET /ot2/link on the Pi, cached 20 s (a failure is cached as down for 20 s too). */
export async function armLinkStatus(opts: { fresh?: boolean } = {}): Promise<{ status: ArmLinkStatus | null; error: string | null }> {
	if (!opts.fresh && cache && Date.now() - cache.at < CACHE_MS) return { status: cache.status, error: cache.error };
	try {
		const r = await robotArmFetchRaw('/ot2/link', { timeoutMs: 4000 });
		if (!r.ok) throw new Error(r.status === 404 ? 'the Pi has no /ot2/link route (install_ot2_link_router.py)' : `robot-arm ${r.status}`);
		const status = JSON.parse(r.text) as ArmLinkStatus;
		cache = { at: Date.now(), status, error: null };
	} catch (e) {
		cache = { at: Date.now(), status: null, error: e instanceof Error ? e.message : String(e) };
	}
	return { status: cache.status, error: cache.error };
}

/** The B07 in "Robot 3 B07" and in "OT2CEP20200217B07". */
export function robotSlot(name: unknown): string | null {
	const m = /([A-Z]\d{2})\s*$/.exec(String(name ?? '').trim());
	return m ? m[1] : null;
}

export function markLinkDown(reason: string): void {
	cache = { at: Date.now() - CACHE_MS + DOWN_MS, status: null, error: reason };
}

/** Is the cable link usable for this robot? The Setup switch, the Pi, a path up, and the right robot on it. */
export async function armLinkFor(robot: { _id?: unknown; name?: string } | null | undefined, opts: { fresh?: boolean } = {}): Promise<ArmLinkView> {
	const checkedAt = new Date().toISOString();
	await connectDB();
	const settings = (await ArmWaxFillSettings.findById('default').select('useArmLink robotId').lean()) as { useArmLink?: boolean; robotId?: string } | null;
	const enabled = settings?.useArmLink !== false;
	const out = (usable: boolean, reason: string | null, status: ArmLinkStatus | null): ArmLinkView => ({ usable, reason, enabled, status, checkedAt });
	if (!enabled) return out(false, 'Cable link off in Setup', null);
	if (!robot) return out(false, 'No robot', null);
	const { status, error } = await armLinkStatus(opts);
	if (!status) return out(false, `Arm Pi: ${error ?? 'unreachable'}`, null);
	if (!status.active) return out(false, `No path to the OT-2 from the Pi (cable: ${status.cable.error ?? 'down'}; LAN: ${status.lan.error ?? 'down'})`, status);
	const want = robotSlot(robot.name);
	const got = robotSlot(status.robot.name);
	if (want && got && want !== got) return out(false, `The Pi's cable reaches ${status.robot.name}, not ${robot.name}`, status);
	return out(true, null, status);
}

// ── Movement Log rows ────────────────────────────────────────────────────

async function logHop(o: { method: string; path: string; status: number | null; link: string | null; ms: number; robotMs: number | null; error: string | null; robot: any }): Promise<void> {
	if (process.env.VITEST) return;
	try {
		await connectDB();
		const via = o.link ? `via ${o.link}` : 'via queue';
		const robotPart = o.robotMs != null ? ` (robot ${o.robotMs.toFixed(0)} ms)` : '';
		await RobotArmMove.create({
			device: 'link',
			at: new Date(Date.now() - o.ms),
			endAt: new Date(),
			durationMs: Math.round(o.ms),
			kind: 'ot2_call',
			what: o.path,
			line: `${o.method} ${o.path.split('?')[0]}  ${o.status ?? 'failed'}  ${via}${robotPart}`.slice(0, 500),
			ok: o.error == null && o.status != null && o.status < 500,
			error: o.error,
			from: 'Run',
			movedBy: null,
			robot: o.robot ? { _id: String(o.robot._id ?? ''), name: String(o.robot.name ?? '') } : undefined
		});
	} catch (err) {
		console.warn('[ot2-arm-link] log row failed:', err instanceof Error ? err.message : err);
	}
}

// ── requests through the Pi ──────────────────────────────────────────────

function asResponse(r: { status: number; text: string; headers: Headers }): Response {
	return new Response(r.text, { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' } });
}

/**
 * One robot request through the Pi. Null when the link is not usable (the
 * caller then uses the queue); throws only when the Pi accepted the call and
 * the robot's own answer is a transport failure (status 502/503 from the Pi).
 */
export async function ot2ViaArm(
	robot: any,
	method: ArmLinkMethod,
	path: string,
	body?: unknown,
	opts: { timeoutMs?: number; log?: boolean; rawBody?: Uint8Array; contentType?: string } = {}
): Promise<Response | null> {
	const link = await armLinkFor(robot);
	if (!link.usable) return null;
	const timeoutMs = opts.timeoutMs ?? 12_000;
	const sep = path.includes('?') ? '&' : '?';
	// The Pi accepts timeout_s up to 60 (2026-11-06: Home Gantry asked for 80 and got a 422 from the Pi, so the home never ran).
	const timeoutS = Math.min(60, Math.max(1, Math.round(timeoutMs / 1000)));
	const t0 = Date.now();
	let r;
	try {
		r = await robotArmFetchRaw(`/ot2/api${path}${sep}timeout_s=${timeoutS}`, { method, body, rawBody: opts.rawBody, contentType: opts.contentType, timeoutMs: timeoutS * 1000 + 3000 });
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		markLinkDown(`arm Pi call failed: ${why}`);
		await logHop({ method, path, status: null, link: null, ms: Date.now() - t0, robotMs: null, error: `Pi unreachable, queue used: ${why}`.slice(0, 300), robot });
		return null;
	}
	const ms = Date.now() - t0;
	const via = r.headers.get('x-ot2-link');
	const robotMs = Number(r.headers.get('x-ot2-ms'));
	// An answer WITHOUT a link header is the Pi's own, never the robot's: it could not reach the robot
	// (502/503) or refused the request itself (422, 401, 404). The queue may still get through.
	if (!via) {
		let detail = r.text.slice(0, 200);
		try {
			detail = String(JSON.parse(r.text)?.detail ?? detail);
		} catch {
			/* keep the text */
		}
		if (r.status === 502 || r.status === 503) markLinkDown(`the Pi cannot reach the OT-2: ${detail}`);
		await logHop({ method, path, status: r.status, link: null, ms, robotMs: null, error: `Pi refused (${r.status}), queue used: ${detail}`.slice(0, 300), robot });
		return null;
	}
	if (opts.log !== false && (method !== 'GET' || r.status >= 500)) {
		await logHop({ method, path, status: r.status, link: via, ms, robotMs: Number.isFinite(robotMs) ? robotMs : null, error: r.ok ? null : r.text.slice(0, 200), robot });
	}
	return asResponse(r);
}

/**
 * robotGet / robotPost / robotDelete: since 2026-11-06 (later) proxy.ts tries
 * the arm Pi's link itself for EVERY server-side robot call (the loop, Jog,
 * Teach, Calibrate, Dry Fill, uploads, the Movement Log's reads), falling back
 * to the queue / LAN — so these are the same calls under the loop's names.
 */
export const ot2Get = (robot: any, path: string): Promise<Response> => robotGet(robot, path);
export const ot2Post = (robot: any, path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<Response> => robotPost(robot, path, body, opts);
export const ot2Delete = (robot: any, path: string): Promise<Response> => robotDelete(robot, path);

// ── the run's pause state, long-polled on the Pi ─────────────────────────

export interface PiMarker {
	kind: string;
	cart: number;
	paused: boolean;
}

export interface PiRunRead {
	status: string;
	message: string | null;
	pause: { kind: string; cart: number } | null;
	last: PiMarker | null;
	prev: PiMarker | null;
	fp: string;
	link: string;
	read_ms: number;
	changed?: boolean;
	waited_ms?: number;
	polls?: number;
}

/**
 * GET /ot2/run/{id}/wait: the read, as soon as it differs from `fp` (at once
 * when fp is null), or after timeoutS. Null when the link is not usable.
 */
export async function ot2WaitChange(robot: any, runId: string, fp: string | null, timeoutS: number): Promise<PiRunRead | null> {
	const link = await armLinkFor(robot);
	if (!link.usable) return null;
	const t = Math.max(0, Math.min(25, timeoutS));
	const t0 = Date.now();
	let r;
	try {
		r = await robotArmFetchRaw(`/ot2/run/${encodeURIComponent(runId)}/wait?fp=${encodeURIComponent(fp ?? '')}&timeout_s=${t}`, { timeoutMs: t * 1000 + 6000 });
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		markLinkDown(`arm Pi wait failed: ${why}`);
		await logHop({ method: 'WAIT', path: `/runs/${runId}`, status: null, link: null, ms: Date.now() - t0, robotMs: null, error: `Pi unreachable, queue polling used: ${why}`.slice(0, 300), robot });
		return null;
	}
	if (!r.ok) {
		let detail = r.text.slice(0, 200);
		try {
			detail = String(JSON.parse(r.text)?.detail ?? detail);
		} catch {
			/* keep */
		}
		if (r.status === 502 || r.status === 503) markLinkDown(`the Pi cannot read the run: ${detail}`);
		await logHop({ method: 'WAIT', path: `/runs/${runId}`, status: r.status, link: null, ms: Date.now() - t0, robotMs: null, error: `queue polling used: ${detail}`.slice(0, 300), robot });
		return null;
	}
	const read = JSON.parse(r.text) as PiRunRead;
	await logHop({
		method: 'WAIT',
		path: `/runs/${runId}`,
		status: 200,
		link: read.link,
		ms: Date.now() - t0,
		robotMs: read.read_ms,
		error: null,
		robot
	}).then(() => undefined);
	return read;
}

// ── the loop's instruction, held on the Pi for the protocol ──────────────

export interface ArmPiInstruction {
	seq: number;
	loop: string;
	cart: number;
	action: string;
	barcode: string | null;
	run_id?: string | null;
}

/** POST /ot2/loop/instruction. True when the Pi holds it; false when the link is not usable or the call failed. */
export async function armSetInstruction(robot: any, rec: ArmPiInstruction): Promise<boolean> {
	const link = await armLinkFor(robot);
	if (!link.usable) return false;
	const t0 = Date.now();
	try {
		const r = await robotArmFetchRaw('/ot2/loop/instruction', { method: 'POST', body: rec, timeoutMs: 8000 });
		await logHop({ method: 'POST', path: `/ot2/loop/instruction seq ${rec.seq} ${rec.action} cart ${rec.cart}`, status: r.status, link: 'pi', ms: Date.now() - t0, robotMs: null, error: r.ok ? null : r.text.slice(0, 200), robot });
		return r.ok;
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		markLinkDown(`arm Pi instruction post failed: ${why}`);
		await logHop({ method: 'POST', path: `/ot2/loop/instruction seq ${rec.seq} ${rec.action}`, status: null, link: null, ms: Date.now() - t0, robotMs: null, error: `file used: ${why}`.slice(0, 300), robot });
		return false;
	}
}

/** The URLs the protocol should try for the Pi, from the Pi's own addresses: the cable first, then the LAN. */
export function armPiUrls(status: ArmLinkStatus | null, port = 8000): string[] {
	const out: string[] = [];
	if (status?.self.cable) out.push(`http://${status.self.cable}:${port}`);
	if (status?.self.lan) out.push(`http://${status.self.lan}:${port}`);
	return out;
}

// ── the barcode over the cable (daemon 1.7.0 on the robot, 2026-11-06) ──

/** The robot's daemon is saying hello to the Pi over the cable: the scan can go that way. */
export function armScanAvailable(link: ArmLinkView | null): boolean {
	return !!link?.usable && !!link.status?.scanner?.fresh;
}

export interface ArmScanWait {
	result: { barcode: string | null; raw: string | null; error: string | null; attempts: number | null; scan_ms?: number | null; pause?: string | null } | null;
	run_status: string | null;
	at_scan: boolean;
	requested: boolean;
	waited_ms: number;
}

/** GET /ot2/loop/scan: the barcode for (run, cart), long-polled up to waitS. Null when the Pi cannot be asked. */
export async function armScanWait(robot: any, runId: string, cart: number, waitS: number): Promise<ArmScanWait | null> {
	const t = Math.max(1, Math.min(25, Math.round(waitS)));
	const t0 = Date.now();
	try {
		const r = await robotArmFetchRaw(`/ot2/loop/scan?run_id=${encodeURIComponent(runId)}&cart=${cart}&wait_s=${t}`, { timeoutMs: t * 1000 + 6000 });
		if (!r.ok) throw new Error(`robot-arm ${r.status}: ${r.text.slice(0, 160)}`);
		const w = JSON.parse(r.text) as ArmScanWait;
		if (w.result) {
			await logHop({
				method: 'SCAN',
				path: `cart ${cart} ${w.result.barcode ?? w.result.error ?? 'no barcode'}`,
				status: 200,
				link: 'cable',
				ms: Date.now() - t0,
				robotMs: w.result.scan_ms ?? null,
				error: w.result.barcode ? null : (w.result.error ?? 'no barcode'),
				robot
			});
		}
		return w;
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		markLinkDown(`arm Pi scan wait failed: ${why}`);
		await logHop({ method: 'SCAN', path: `cart ${cart}`, status: null, link: null, ms: Date.now() - t0, robotMs: null, error: `queue scan used: ${why}`.slice(0, 300), robot });
		return null;
	}
}

/** POST /ot2/loop/file: the arm Pi writes /data/arm_loop.json on the robot over SSH (cable first). False when it could not. */
export async function armWriteFile(robot: any, json: Record<string, unknown>): Promise<boolean> {
	const link = await armLinkFor(robot);
	if (!link.usable) return false;
	const t0 = Date.now();
	try {
		const r = await robotArmFetchRaw('/ot2/loop/file', { method: 'POST', body: { json }, timeoutMs: 12_000 });
		await logHop({ method: 'FILE', path: `/data/arm_loop.json seq ${json.seq} ${json.action}`, status: r.status, link: 'cable', ms: Date.now() - t0, robotMs: null, error: r.ok ? null : r.text.slice(0, 200), robot });
		return r.ok;
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		await logHop({ method: 'FILE', path: `/data/arm_loop.json seq ${json.seq}`, status: null, link: null, ms: Date.now() - t0, robotMs: null, error: `queue used: ${why}`.slice(0, 300), robot });
		return false;
	}
}
