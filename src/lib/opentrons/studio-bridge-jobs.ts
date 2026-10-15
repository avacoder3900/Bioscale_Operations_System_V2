/**
 * Calibration-studio + scanner-tool daemon jobs on the TAILNET line
 * (OT2-TAILNET-5 §7.3 / §7.5, S6).
 *
 * The ONE browser-side implementation of "prepare → submit → progress → record"
 * for the two daemon actions the studio pages start:
 *
 *   calibrate_tip   deck-calibration  (/api/scanner/calibrate-tip)
 *   test-scan       scanner-positions/[setId], opentron-control/scanner-test
 *                   (/api/scanner/trigger + the daemon's POST /bridge/scan)
 *
 * Pages call these ONLY when `RobotSession.bridge()` returned a client (the
 * session is on the direct line AND this deployment allows daemon jobs). When it
 * is null the page runs its existing queue code, untouched — nothing here is on
 * the queue line.
 *
 * Rules (same as RobotSession's NO_RETRY verbs):
 *   - A job start / scan is NEVER auto-retried and NEVER re-sent through the BIMS
 *     queue: it could run twice. If the robot's answer to the start is lost, the
 *     only follow-up is a READ (getJob) of the jobId the prepare half minted.
 *   - The BIMS rows come from the routes: prepare first (the routes resolve every
 *     input server-side), record last (calibrate-tip's tailnet confirm does
 *     readProbeResult + AuditLog 'calibrate_tip' line:'tailnet'). A test-scan
 *     needs no record — the daemon posts the ScannerEvent itself
 *     (metadata.bridgeScanId), which is then read back from /api/scanner/events.
 *   - Neither prepare half writes a row, so a failed submit leaves nothing to
 *     close — the error is surfaced and the operator decides.
 *
 * Isomorphic: no DOM, no $lib/server, no Svelte.
 */
import { BridgeError, type BridgeClient, type BridgeJob, type BridgeJobDescriptor } from './bridge-client';

export type BimsFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type StudioJobStage = 'prepare' | 'submit' | 'poll' | 'record';

/** A tailnet studio action that did not complete; `stage` says where it stopped. */
export class StudioJobError extends Error {
	constructor(
		message: string,
		readonly stage: StudioJobStage,
		/** true = the robot may have acted (its answer was lost) — check before retrying. */
		readonly mayHaveRun = false
	) {
		super(message);
		this.name = 'StudioJobError';
	}
}

export const CALIBRATE_TIP_ROUTE = '/api/scanner/calibrate-tip';
export const TRIGGER_ROUTE = '/api/scanner/trigger';
export const EVENTS_ROUTE = '/api/scanner/events';

/** Same budget as the queue line's route (COMMAND_TTL_MS): a probe is ~1-2 min. */
export const CALIBRATE_POLL_TIMEOUT_MS = 270_000;
export const CALIBRATE_POLL_INTERVAL_MS = 1000;

const defaultBimsFetch: BimsFetch = (input, init) => globalThis.fetch(input, init);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** POST JSON to a BIMS route; throws with the route's own message on !ok. */
async function postBims(bimsFetch: BimsFetch, path: string, body: unknown): Promise<any> {
	const res = await bimsFetch(path, {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	const text = await res.text();
	let parsed: any = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}
	if (!res.ok) {
		const msg =
			(parsed && typeof parsed === 'object' && (parsed.message || parsed.error)) ||
			(typeof parsed === 'string' && parsed) ||
			`HTTP ${res.status}`;
		throw new Error(String(msg));
	}
	return parsed;
}

/** One line for the page's status text from a /bridge job snapshot. */
export function describeJobProgress(job: Pick<BridgeJob, 'status' | 'queuePosition' | 'progress'>): string {
	if (job.status === 'queued') {
		return job.queuePosition && job.queuePosition > 0
			? `waiting for the robot (${job.queuePosition} ahead)`
			: 'queued on the robot';
	}
	const log = job.progress?.log ?? [];
	const last = log.length ? log[log.length - 1]?.message : '';
	if (job.status === 'running') return last ? String(last) : 'running on the robot…';
	return last ? `${job.status}: ${last}` : job.status;
}

/**
 * Start a daemon job the route prepared, never retrying. On a lost answer the
 * jobId is READ once to see whether it landed; true = it is on the robot.
 */
async function submitOnce(bridge: BridgeClient, job: BridgeJobDescriptor, what: string): Promise<void> {
	try {
		await bridge.submit(job);
		return;
	} catch (e) {
		const lost = e instanceof BridgeError && e.code === 'network';
		if (lost && job.jobId) {
			try {
				await bridge.getJob(job.jobId); // a read, not a re-submit
				return; // it landed — carry on as if the answer had arrived
			} catch {
				/* unknown: say so below */
			}
		}
		throw new StudioJobError(
			lost
				? `The robot's answer to the ${what} start was lost (${errText(e)}). It may be running on the robot — it was NOT retried and NOT sent via the BIMS queue. Check the robot before trying again.`
				: `The robot did not start the ${what}: ${errText(e)}. Nothing was sent via the BIMS queue.`,
			'submit',
			lost
		);
	}
}

export interface CalibrateTipOptions {
	bimsFetch?: BimsFetch;
	/** Live status line from /bridge/jobs/:id (no Vercel hop). */
	onProgress?: (text: string, job: BridgeJob) => void;
	signal?: AbortSignal;
	pollIntervalMs?: number;
	pollTimeoutMs?: number;
}

/**
 * Tip calibration on the tailnet line. `request` is EXACTLY the body the page
 * would POST to /api/scanner/calibrate-tip on the queue line; it is sent again
 * on confirm so the route re-resolves every input server-side.
 *
 * Returns the route's ProbeResponse (same shape as the queue line):
 * { success, probed, probedSource, adjust, calibrator, calibratorSource, error? }.
 * Throws StudioJobError when the prepare, submit or record half fails.
 */
export async function calibrateTipOverBridge(
	bridge: BridgeClient,
	request: Record<string, unknown>,
	opts: CalibrateTipOptions = {}
): Promise<any> {
	const bimsFetch = opts.bimsFetch ?? defaultBimsFetch;

	// 1. PREPARE (BIMS): guards, tiprack + calibrator resolution, the payload.
	let prepared: any;
	try {
		prepared = await postBims(bimsFetch, CALIBRATE_TIP_ROUTE, { ...request, line: 'tailnet', phase: 'prepare' });
	} catch (e) {
		throw new StudioJobError(`Tip calibration was not started: ${errText(e)}`, 'prepare');
	}
	const job = prepared?.job as BridgeJobDescriptor | undefined;
	if (!job || job.kind !== 'calibrate_tip' || typeof job.jobId !== 'string' || !job.jobId) {
		throw new StudioJobError('Tip calibration was not started: BIMS returned no calibrate_tip job', 'prepare');
	}

	// 2. SUBMIT (robot daemon, never retried).
	await submitOnce(bridge, job, 'tip calibration');

	// 3. PROGRESS (robot daemon). A lost poll is not a failed probe — but this
	//    page can no longer see the reading, so it is recorded as "no reading".
	let final: BridgeJob | null = null;
	let pollError: string | null = null;
	try {
		final = await bridge.pollJob(
			job.jobId,
			(j) => opts.onProgress?.(describeJobProgress(j), j),
			{
				intervalMs: opts.pollIntervalMs ?? CALIBRATE_POLL_INTERVAL_MS,
				timeoutMs: opts.pollTimeoutMs ?? CALIBRATE_POLL_TIMEOUT_MS,
				signal: opts.signal
			}
		);
	} catch (e) {
		pollError =
			`Lost track of the tip calibration on the robot (${errText(e)}). ` +
			'The probe may still finish there; nothing was taught here.';
	}

	// 4. RECORD (BIMS): the same completion half as the queue line.
	try {
		return await postBims(bimsFetch, CALIBRATE_TIP_ROUTE, {
			...request,
			line: 'tailnet',
			phase: 'confirm',
			jobId: job.jobId,
			status: final ? final.status : 'failed',
			result: final ? (final.result ?? null) : null,
			error: final ? (final.error ?? null) : pollError
		});
	} catch (e) {
		throw new StudioJobError(
			`The robot ${final?.status === 'completed' ? 'finished the probe' : 'answered'}, but BIMS did not record it: ${errText(e)}`,
			'record',
			true
		);
	}
}

export interface TestScanRequest {
	/** The scanner's ScannerEvent deviceId (ot2-<slot>-scanner). */
	deviceId: string;
	robotId: string;
	source?: string;
	contextRef?: string;
}

export interface TestScanOutcome {
	scanId: string;
	barcode: string | null;
	error: string | null;
	/** The ScannerEvent's receivedAt when it was found, else the browser's clock. */
	receivedAt: string;
	eventPosted: boolean;
	/** The ScannerEvent the daemon posted (from /api/scanner/events), if found. */
	event: Record<string, any> | null;
}

export interface TestScanOptions {
	bimsFetch?: BimsFetch;
	/** How many times to look for the daemon's ScannerEvent (default 5, 400 ms apart). */
	eventLookups?: number;
	eventLookupIntervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
	nowIso?: () => string;
}

/**
 * One scanner test-scan on the tailnet line: the route's prepare (gate +
 * validated payload, no ScannerTrigger) → the daemon's /bridge/scan (synchronous,
 * same ScannerPort lock as the trigger loop) → the daemon's ScannerEvent read
 * back from /api/scanner/events by metadata.bridgeScanId.
 */
export async function testScanOverBridge(
	bridge: BridgeClient,
	req: TestScanRequest,
	opts: TestScanOptions = {}
): Promise<TestScanOutcome> {
	const bimsFetch = opts.bimsFetch ?? defaultBimsFetch;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const nowIso = opts.nowIso ?? (() => new Date().toISOString());

	let prepared: any;
	try {
		prepared = await postBims(bimsFetch, TRIGGER_ROUTE, {
			deviceId: req.deviceId,
			robotId: req.robotId,
			source: req.source ?? 'test',
			...(req.contextRef !== undefined ? { contextRef: req.contextRef } : {}),
			line: 'tailnet'
		});
	} catch (e) {
		throw new StudioJobError(`Test scan was not started: ${errText(e)}`, 'prepare');
	}
	const job = prepared?.job as { kind?: string; payload?: { source?: string; contextRef?: string } } | undefined;
	if (!job || job.kind !== 'scan') {
		throw new StudioJobError('Test scan was not started: BIMS returned no scan job', 'prepare');
	}

	let scan;
	try {
		scan = await bridge.testScan(job.payload ?? {});
	} catch (e) {
		const lost = e instanceof BridgeError && e.code === 'network';
		throw new StudioJobError(
			lost
				? `The robot's answer to the test scan was lost (${errText(e)}). The scanner may have fired — it was NOT retried and NOT sent via the BIMS queue.`
				: `The robot did not run the test scan: ${errText(e)}. Nothing was sent via the BIMS queue.`,
			'submit',
			lost
		);
	}

	let event: Record<string, any> | null = null;
	if (scan.eventPosted && scan.scanId) {
		const tries = Math.max(0, opts.eventLookups ?? 5);
		for (let i = 0; i < tries && !event; i++) {
			if (i > 0) await sleep(opts.eventLookupIntervalMs ?? 400);
			try {
				const q = new URLSearchParams({ deviceId: req.deviceId, limit: '20' });
				const r = await bimsFetch(`${EVENTS_ROUTE}?${q}`, { credentials: 'same-origin' });
				if (!r.ok) continue;
				const body = await r.json();
				const evs: any[] = body?.events ?? [];
				event = evs.find((ev) => ev?.metadata?.bridgeScanId === scan.scanId) ?? null;
			} catch {
				/* the scan result below stands on its own */
			}
		}
	}

	return {
		scanId: scan.scanId,
		barcode: scan.barcode ?? null,
		error: scan.error ?? null,
		receivedAt: typeof event?.receivedAt === 'string' ? event.receivedAt : nowIso(),
		eventPosted: !!scan.eventPosted,
		event
	};
}
