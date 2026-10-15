/**
 * Opentrons OT-2 HTTP proxy helpers.
 * Provides utilities for forwarding requests to robot HTTP APIs.
 *
 * OT2-BRIDGE-1: every robot request flows through a transport switch.
 *  - 'direct'  — fetch http://{robot.ip}:{port} (works when BIMS runs on the
 *                lab LAN, e.g. local dev).
 *  - 'bridge'  — enqueue an Ot2BridgeCommand and wait for the on-robot
 *                ot2-bridge daemon to relay it (works from Vercel, which
 *                cannot reach the lab LAN).
 *  - OT2_TRANSPORT env selects ('direct' | 'bridge' | 'auto'); 'auto'
 *    (default) picks bridge on Vercel, direct elsewhere.
 */

import { connectDB, OpentronsRobot, Ot2BridgeCommand, ScannerEvent, generateId, LabwareDefinition } from '$lib/server/db';
import { labwareNamesReferencedBy } from './labware-refs';
import { isHardenedRobot, rolloutNote } from '$lib/server/services/deck-calibration/rollout';
import { runVerb, PRE_ANALYZED_FIELD, type ProtocolUploadBundle } from '$lib/opentrons/ot2-protocol';

const DEFAULT_PORT = 31950;

type Ot2Transport = 'direct' | 'bridge';

function resolveTransport(): Ot2Transport {
	const mode = (process.env.OT2_TRANSPORT ?? 'auto').toLowerCase();
	if (mode === 'direct' || mode === 'bridge') return mode;
	return process.env.VERCEL ? 'bridge' : 'direct';
}

/** ot2-<slot>-bridge — same slot-code derivation as the scanner deviceId */
export function bridgeDeviceIdForRobot(robot: { name?: string; bridgeDeviceId?: string }): string {
	if (robot.bridgeDeviceId) return robot.bridgeDeviceId;
	const match = (robot.name ?? '').match(/\b([A-Z]\d{2})\b/);
	const slot = match?.[1]?.toLowerCase();
	return slot ? `ot2-${slot}-bridge` : 'unknown-bridge';
}

const BRIDGE_POLL_MS = 100;
const BRIDGE_TIMEOUT_MS = 30_000; // parity with the direct robotFetch abort

/**
 * Relay one HTTP request through the command queue and wait for the daemon's
 * result. Returns a real Response so call sites are transport-agnostic.
 */
async function bridgeFetch(
	robot: any,
	method: string,
	path: string,
	body?: unknown
): Promise<Response> {
	await connectDB();
	const deviceId = bridgeDeviceIdForRobot(robot);
	const cmd = await Ot2BridgeCommand.create({
		_id: generateId(),
		robotId: String(robot._id ?? ''),
		deviceId,
		kind: 'http',
		request: { method, path, body: body ?? null },
		ttlMs: BRIDGE_TIMEOUT_MS
	});

	const deadline = Date.now() + BRIDGE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const doc = await Ot2BridgeCommand.findById(cmd._id)
			.select('status result error').lean() as any;
		if (doc?.status === 'completed') {
			return new Response(JSON.stringify(doc.result?.body ?? null), {
				status: doc.result?.status ?? 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		if (doc?.status === 'failed' || doc?.status === 'expired') {
			throw new Error(`${method} ${path} failed via bridge (${deviceId}): ${doc.error ?? doc.status}`);
		}
		await new Promise((r) => setTimeout(r, BRIDGE_POLL_MS));
	}

	// Timed out waiting — mark the command terminal and surface daemon liveness
	await Ot2BridgeCommand.updateOne(
		{ _id: cmd._id, status: { $in: ['pending', 'claimed'] } },
		{ $set: { status: 'expired', error: 'BIMS gave up waiting for the bridge daemon', completedAt: new Date() } }
	).catch(() => {});
	const lastBeat = await ScannerEvent.findOne({
		deviceId,
		eventType: 'heartbeat'
	}).sort({ receivedAt: -1 }).select('receivedAt').lean().catch(() => null) as any;
	const beatInfo = lastBeat?.receivedAt
		? `last bridge heartbeat ${Math.round((Date.now() - new Date(lastBeat.receivedAt).getTime()) / 60000)} min ago`
		: 'no bridge heartbeat ever received';
	throw new Error(`${method} ${path} failed: robot bridge "${deviceId}" did not respond within ${BRIDGE_TIMEOUT_MS / 1000}s (${beatInfo})`);
}

/** Get a robot record by DB id and assert it's active */
export async function getRobot(id: string) {
	await connectDB();
	const robot = await OpentronsRobot.findById(id).lean() as any;
	if (!robot || robot.isActive === false) return null;
	return robot;
}

/** Build the base URL for a robot's HTTP API */
export function robotBaseUrl(robot: { ip: string; port?: number | null }): string {
	const port = robot.port ?? DEFAULT_PORT;
	return `http://${robot.ip}:${port}`;
}

// Node's undici surfaces the real reason (ECONNREFUSED, ETIMEDOUT, ENOTFOUND, ...)
// on err.cause, not err.message. Without unwrapping it the caller only sees
// "fetch failed", which is useless for diagnosing why the robot is unreachable.
//
// A 30-second per-request abort signal guards against wedged Node keepalive
// sockets that can leave a sweep stuck mid-call when the OT-2 or network
// blips. 30s matches the OT-2's own per-command waitUntilComplete timeout —
// any single HTTP hop hanging past that is a stuck socket, not a slow move.
async function robotFetch(url: string, init: RequestInit & { method?: string } = {}, timeoutMs = 30_000): Promise<Response> {
	const method = init.method ?? 'GET';
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(new Error(`robotFetch timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: ac.signal });
	} catch (e: any) {
		const cause = e?.cause;
		const causeCode = (cause as any)?.code;
		const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : '';
		const causePart = causeMsg
			? ` — ${causeCode ? `[${causeCode}] ` : ''}${causeMsg}`
			: '';
		throw new Error(`${method} ${url} failed: ${e?.message ?? 'unknown'}${causePart}`);
	} finally {
		clearTimeout(timer);
	}
}

/** Proxy a GET request to the robot */
export async function robotGet(robot: any, path: string): Promise<Response> {
	if (resolveTransport() === 'bridge') return bridgeFetch(robot, 'GET', path);
	const url = `${robotBaseUrl(robot)}${path}`;
	return robotFetch(url, {
		headers: { 'opentrons-version': '3' }
	});
}

/** Proxy a POST request to the robot. opts.timeoutMs overrides the 30s default
 *  for slow commands (e.g. home, which can take 30-60s). */
export async function robotPost(robot: any, path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<Response> {
	if (resolveTransport() === 'bridge') return bridgeFetch(robot, 'POST', path, body);
	const url = `${robotBaseUrl(robot)}${path}`;
	return robotFetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'opentrons-version': '3'
		},
		body: body !== undefined ? JSON.stringify(body) : undefined
	}, opts.timeoutMs);
}

/** Proxy a PATCH request to the robot */
export async function robotPatch(robot: any, path: string, body?: unknown): Promise<Response> {
	if (resolveTransport() === 'bridge') return bridgeFetch(robot, 'PATCH', path, body);
	const url = `${robotBaseUrl(robot)}${path}`;
	return robotFetch(url, {
		method: 'PATCH',
		headers: {
			'Content-Type': 'application/json',
			'opentrons-version': '3'
		},
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
}

/**
 * Proxy a PUT request to the robot — same shape and transport switch as
 * robotPatch (one kind:'http' queue command on Vercel). The relay uses it for
 * the Opentrons UI's PUT /clientData/{key} and PUT /system/time (OT2-TAILNET-5).
 */
export async function robotPut(robot: any, path: string, body?: unknown): Promise<Response> {
	if (resolveTransport() === 'bridge') return bridgeFetch(robot, 'PUT', path, body);
	const url = `${robotBaseUrl(robot)}${path}`;
	return robotFetch(url, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
			'opentrons-version': '3'
		},
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
}

/** Proxy a DELETE request to the robot */
export async function robotDelete(robot: any, path: string): Promise<Response> {
	if (resolveTransport() === 'bridge') return bridgeFetch(robot, 'DELETE', path);
	const url = `${robotBaseUrl(robot)}${path}`;
	return robotFetch(url, {
		method: 'DELETE',
		headers: { 'opentrons-version': '3' }
	});
}

/** Parse and forward a robot response */
export async function forwardResponse(res: Response): Promise<{ data: unknown; status: number }> {
	const data = await res.json().catch(() => null);
	return { data, status: res.status };
}

/** Save last known health to robot record */
export async function updateRobotHealth(
	robotId: string,
	isHealthy: boolean,
	snapshot?: Record<string, unknown>
): Promise<void> {
	await OpentronsRobot.updateOne(
		{ _id: robotId },
		{
			lastHealthAt: new Date(),
			lastHealthOk: isHealthy,
			...(snapshot ? {
				$push: {
					recentHealthSnapshots: {
						$each: [{ ...snapshot, isHealthy, createdAt: new Date() }],
						$slice: -20 // Keep last 20 snapshots
					}
				}
			} : {})
		}
	);
}

// Protocol upload (OT2-BRIDGE-3, split for OT2-TAILNET-5 §7.2) ----------------
//
// An upload is two halves:
//   assembleProtocolUpload()  BIMS half — the .py + the labware it loads, from
//                             Mongo (hardened robots: only referenced loadNames)
//   'run.uploadProtocol'      robot half, in $lib/opentrons/ot2-protocol — the
//                             multipart POST /protocols + analysis wait, run over
//                             either line. On the queue line that POST lands in
//                             robotPostMultipart() below, which keeps the
//                             `upload_protocol` bridge job exactly as before.

/** Normalized result of uploading + analyzing a protocol on a robot. */
export interface UploadedProtocol {
	opentronsProtocolId: string;
	analysisStatus: string;
	parametersSchema: unknown;
	labwareDefinitions: unknown;
	pipettesRequired: unknown;
	analysisErrors?: string[];
}

// The bridged upload waits for the daemon to upload AND analyze on-robot, which
// takes longer than the 30s http relay. Keep under the endpoint's maxDuration
// (120s) and over the daemon's analysis budget (~60s).
const UPLOAD_BRIDGE_TIMEOUT_MS = 110_000;

/** Relay an upload_protocol command through the bridge and await the daemon's
 *  result. Mirrors bridgeFetch but with a file payload and a longer deadline. */
async function bridgeUpload(robot: any, fileName: string, fileB64: string, labware: { fileName: string; b64: string }[]): Promise<any> {
	await connectDB();
	const deviceId = bridgeDeviceIdForRobot(robot);
	const cmd = await Ot2BridgeCommand.create({
		_id: generateId(),
		robotId: String(robot._id ?? ''),
		deviceId,
		kind: 'upload_protocol',
		payload: { fileName, fileB64, labware },
		ttlMs: UPLOAD_BRIDGE_TIMEOUT_MS
	});

	const deadline = Date.now() + UPLOAD_BRIDGE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const doc = await Ot2BridgeCommand.findById(cmd._id).select('status result error').lean() as any;
		if (doc?.status === 'completed') return doc.result?.body ?? null;
		if (doc?.status === 'failed' || doc?.status === 'expired') {
			throw new Error(`upload via bridge (${deviceId}) failed: ${doc.error ?? doc.status}`);
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	await Ot2BridgeCommand.updateOne(
		{ _id: cmd._id, status: { $in: ['pending', 'claimed'] } },
		{ $set: { status: 'expired', error: 'BIMS gave up waiting for the bridge daemon', completedAt: new Date() } }
	).catch(() => {});
	throw new Error(`upload failed: robot bridge "${deviceId}" did not respond within ${UPLOAD_BRIDGE_TIMEOUT_MS / 1000}s`);
}

const blobB64 = async (b: Blob) => Buffer.from(new Uint8Array(await b.arrayBuffer())).toString('base64');

/**
 * The server line's multipart POST (serverTransport routes a FormData body
 * here). Only POST /protocols is multipart on the OT-2.
 *  - bridge: the parts (the .py first, then labware JSON — buildProtocolForm's
 *    order) become the same `upload_protocol` job payload as before; the daemon
 *    uploads AND waits for the analysis, so the answer carries it pre-analyzed.
 *  - direct (lab LAN): the multipart POST itself, `opentrons-version: *`.
 */
export async function robotPostMultipart(robot: any, path: string, form: FormData, opts: { timeoutMs?: number } = {}): Promise<Response> {
	if (resolveTransport() === 'bridge') {
		if (path !== '/protocols') throw new Error(`multipart ${path} is not supported over the bridge`);
		const parts = form.getAll('files').filter((p): p is File => typeof p !== 'string');
		const [py, ...rest] = parts;
		if (!py) throw new Error('upload has no protocol file');
		const fileB64 = await blobB64(py);
		const labwareB64 = await Promise.all(rest.map(async (l) => ({ fileName: l.name, b64: await blobB64(l) })));
		const body = await bridgeUpload(robot, py.name, fileB64, labwareB64);
		const pid = body?.opentronsProtocolId ?? body?.id;
		if (!pid) throw new Error(`bridge upload returned no protocol id: ${JSON.stringify(body)?.slice(0, 200)}`);
		const analyzed: UploadedProtocol = {
			opentronsProtocolId: pid,
			analysisStatus: body?.analysisStatus ?? 'unknown',
			parametersSchema: body?.parametersSchema ?? null,
			labwareDefinitions: body?.labwareDefinitions ?? null,
			pipettesRequired: body?.pipettesRequired ?? null,
			...(Array.isArray(body?.analysisErrors) ? { analysisErrors: body.analysisErrors } : {})
		};
		return new Response(JSON.stringify({ data: { id: pid }, [PRE_ANALYZED_FIELD]: analyzed }), {
			status: 201,
			headers: { 'content-type': 'application/json' }
		});
	}
	return robotFetch(
		`${robotBaseUrl(robot)}${path}`,
		{ method: 'POST', headers: { 'opentrons-version': '*' }, body: form },
		opts.timeoutMs
	);
}

/**
 * BIMS half of an upload: the .py plus the BIMS-managed labware it actually
 * loads, so the robot resolves its custom labware at run time (the OT-2
 * resolves from what's bundled at upload). `source` is the .py text (stored
 * protocols) or its exact bytes (an uploaded file).
 *
 * This used to ship the ENTIRE library on every upload. That was wasteful and
 * unsafe: two definitions sharing a loadName produce the same multipart
 * filename, and which one the robot keeps is undefined — so a stale copy
 * could silently win over freshly-calibrated geometry. Narrowing to the
 * referenced set, and hard-failing on ambiguity, removes that class of bug.
 */
export async function assembleProtocolUpload(robot: any, fileName: string, source: string | Uint8Array): Promise<ProtocolUploadBundle> {
	await connectDB();
	const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
	// Gated per robot: narrowing can fail an upload that previously succeeded
	// (missing or ambiguous definition), so it stays off until a robot is opted in.
	const narrow = isHardenedRobot(robot);
	const referenced = narrow ? labwareNamesReferencedBy(text) : [];
	console.log(`[opentrons] ${fileName}: ${rolloutNote(robot)}`);

	let defs: any[];
	if (referenced.length) {
		defs = await LabwareDefinition.find({ loadName: { $in: referenced } })
			.select('fileName loadName namespace version definition')
			.lean() as any[];

		const found = new Set(defs.map((d) => String(d.loadName)));
		const missing = referenced.filter((n) => !found.has(n));
		if (missing.length) {
			throw new Error(
				`Protocol ${fileName} loads labware missing from the BIMS library: ${missing.join(', ')}. ` +
					`Upload the definition(s) before deploying this protocol.`
			);
		}
		const byName = new Map<string, number>();
		for (const d of defs) byName.set(String(d.loadName), (byName.get(String(d.loadName)) ?? 0) + 1);
		const ambiguous = [...byName.entries()].filter(([, c]) => c > 1);
		if (ambiguous.length) {
			throw new Error(
				`Refusing to upload: ${ambiguous.map(([n, c]) => `${n} matches ${c} definitions`).join('; ')}. ` +
					`The robot would keep an arbitrary one. Archive the duplicates first.`
			);
		}
	} else {
		// Legacy path: the whole library. Also the fallback when narrowing is on but
		// nothing parsed — better a fat bundle than a protocol with no custom labware.
		if (narrow) console.warn(`[opentrons] ${fileName}: no load_labware calls parsed; bundling full library`);
		defs = await LabwareDefinition.find().select('fileName loadName namespace version definition').lean() as any[];
	}

	const labware = defs.map((d) => {
		const fn = (d.fileName && String(d.fileName).endsWith('.json')) ? String(d.fileName) : `${d.loadName}.json`;
		return { fileName: fn, json: JSON.stringify(d.definition) };
	});

	// Two parts with the same filename in one multipart body = undefined winner.
	const seen = new Map<string, string>();
	for (const d of defs) {
		const fn = (d.fileName && String(d.fileName).endsWith('.json')) ? String(d.fileName) : `${d.loadName}.json`;
		const prev = seen.get(fn);
		if (prev && prev !== d.loadName) {
			throw new Error(
				`Refusing to upload: "${prev}" and "${d.loadName}" both bundle as "${fn}". ` +
					`Rename one definition's fileName so the robot cannot keep the wrong geometry.`
			);
		}
		seen.set(fn, String(d.loadName));
	}
	console.log(`[opentrons] ${fileName}: bundling ${labware.length} labware def(s): ${defs.map((d) => d.loadName).join(', ')}`);

	return typeof source === 'string'
		? { fileName, fileContent: source, labware }
		: { fileName, fileB64: Buffer.from(source).toString('base64'), labware };
}

/**
 * Upload a protocol .py to a robot and return its analyzed metadata over the
 * server line (the bridge on Vercel, direct on the lab LAN). Same result and
 * error messages as before the split: assembly here, the transfer in the shared
 * 'run.uploadProtocol' verb (the tailnet line runs that verb in the browser).
 */
export async function robotUploadProtocol(robot: any, fileName: string, bytes: Uint8Array): Promise<UploadedProtocol> {
	const bundle = await assembleProtocolUpload(robot, fileName, bytes);
	return uploadAssembledProtocol(robot, bundle);
}

/** Run the robot half of an assembled upload over the server line; throws on failure. */
export async function uploadAssembledProtocol(robot: any, bundle: ProtocolUploadBundle): Promise<UploadedProtocol> {
	// transport.ts imports this module; a lazy import keeps the graph acyclic.
	const { serverTransport } = await import('./transport');
	const r = await runVerb(serverTransport(robot), 'run.uploadProtocol', bundle as unknown as Record<string, unknown>);
	if (r.status !== 200) throw new Error((r.body as any)?.message ?? 'Failed to upload protocol');
	return r.body as UploadedProtocol;
}
