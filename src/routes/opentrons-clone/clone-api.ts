/**
 * The Opentrons UI's robot calls, in the browser (OT2-TAILNET-5 S10b).
 *
 * Each function here is what a /opentrons-clone/[robotId]/**\/+page.server.ts
 * load or form action used to do from the server by fetching the robot LAN IP
 * — moved as-is, now over the page's robot session:
 *   typed reads  → robot-client (openapi-fetch) over session.robotFetch
 *   raw writes   → session.robotFetch (tracked; /direct-calls on the direct line,
 *                  the BIMS relay on the queue line)
 * Nothing here writes to BIMS (the clone never did); the relay audits queue
 * mutations and /direct-calls traces direct ones.
 */
import { safeGet, latestAnalysis, downloadRobotFile } from '$lib/opentrons/robot-client';
import type { CloneLine } from './clone-session';
import { answer, failure, ok, redirectTo, type CloneAction, type CloneOutcome } from './clone-form';

// No opentrons-version here: the session sets '3' on the direct line and the
// relay (proxy.ts) sends '3' on the queue line, so a call is the same robot
// request on both. Multipart uploads (direct-only) keep the '*' they always sent.
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const NO_HEADERS = {};
const MULTIPART_VERSION = { 'opentrons-version': '*' };
const enc = encodeURIComponent;

async function post(line: CloneLine, path: string, body: unknown, timeoutMs = 30_000): Promise<Response> {
	return line.session.robotFetch(path, {
		method: 'POST',
		headers: JSON_HEADERS,
		body: body === null ? undefined : JSON.stringify(body),
		timeoutMs
	});
}
async function send(line: CloneLine, method: 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, timeoutMs = 10_000) {
	return line.session.robotFetch(path, {
		method,
		headers: body === undefined ? NO_HEADERS : JSON_HEADERS,
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		timeoutMs
	});
}
const newestFirst = (a: any, b: any) => new Date(b?.createdAt ?? 0).getTime() - new Date(a?.createdAt ?? 0).getTime();

/** GET a list endpoint's `data` array; online=false on any error. */
async function list(line: CloneLine, path: string, query?: Record<string, unknown>): Promise<{ online: boolean; items: any[] }> {
	try {
		const res = await (line.client as any).GET(path, query ? { params: { query } } : {});
		if (res.error !== undefined) return { online: false, items: [] };
		return { online: true, items: res.data?.data ?? [] };
	} catch {
		return { online: false, items: [] };
	}
}

/**
 * A robot file (log, data file, analysis document) → a browser download, via a
 * direct robotFetch and a blob URL (was an /api/opentrons-clone pass-through).
 * Returns the error text, or null. Files need the tailnet line.
 */
export async function downloadFile(line: CloneLine, path: string, filename: string, accept?: string): Promise<string | null> {
	try {
		await downloadRobotFile((p, i) => line.session.robotFetch(p, i), path, filename, accept);
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

// ── [robotId] overview ──────────────────────────────────────────────────────

export async function loadOverview(line: CloneLine) {
	const c = line.client;
	const [health, instruments, modules, calibrationStatus, pipetteOffsets, tipLengths, lights] = await Promise.all([
		safeGet<any>(c, '/health'),
		safeGet<any>(c, '/instruments'),
		safeGet<any>(c, '/modules'),
		safeGet<any>(c, '/calibration/status'),
		safeGet<any>(c, '/calibration/pipette_offset'),
		safeGet<any>(c, '/calibration/tip_length'),
		safeGet<any>(c, '/robot/lights')
	]);
	return {
		online: health !== null,
		health,
		instruments: instruments?.data ?? [],
		modules: modules?.data ?? [],
		calibrationStatus: calibrationStatus ?? null,
		pipetteOffsets: pipetteOffsets?.data ?? [],
		tipLengths: tipLengths?.data ?? [],
		lightsOn: (lights as any)?.on ?? false
	};
}

export function overviewActions(line: CloneLine): Record<string, CloneAction> {
	return {
		home: async (form) => {
			const target = form.get('target')?.toString() ?? 'robot';
			const body: Record<string, unknown> = { target };
			if (target === 'pipette') {
				const mount = form.get('mount')?.toString();
				if (mount === 'left' || mount === 'right') body.mount = mount;
				else return failure(400, 'pipette target requires mount=left|right');
			}
			return answer(await post(line, '/robot/home', body, 60_000), 'Home failed', () =>
				ok({ message: `Homed ${target}${body.mount ? ` ${body.mount}` : ''}` })
			);
		},
		lights: async (form) => {
			const on = form.get('on')?.toString() === 'true';
			return answer(await post(line, '/robot/lights', { on }, 5_000), 'Lights toggle failed', () => ok({ message: `Lights ${on ? 'on' : 'off'}` }));
		},
		identify: async (form) => {
			const seconds = Math.min(Math.max(parseInt(form.get('seconds')?.toString() ?? '5', 10) || 5, 1), 30);
			return answer(await post(line, `/identify?seconds=${seconds}`, null, 5_000), 'Identify failed', () =>
				ok({ message: `Identifying for ${seconds}s` })
			);
		}
	};
}

// ── protocols ───────────────────────────────────────────────────────────────

export async function loadProtocols(line: CloneLine) {
	const { online, items } = await list(line, '/protocols');
	return { online, protocols: [...items].sort(newestFirst) };
}

export function protocolsActions(line: CloneLine): Record<string, CloneAction> {
	return {
		upload: async (form) => {
			const mainFile = form.get('protocol');
			if (!(mainFile instanceof File) || mainFile.size === 0) return failure(400, 'Protocol file is required');
			const supportFiles = form.getAll('support').filter((f) => f instanceof File && f.size > 0) as File[];

			if (line.session.state.transport !== 'direct') {
				// Multipart can't ride the relay. The queue line reuses the BIMS upload
				// route (bridge upload + analysis), which takes the main file only.
				if (supportFiles.length) {
					return failure(409, 'needs Tailscale — support files can only be uploaded from a computer on the tailnet (the BIMS queue takes the main file only)');
				}
				const fd = new FormData();
				fd.append('protocolFile', mainFile, mainFile.name);
				const res = await fetch(`/api/opentrons-lab/robots/${enc(line.robotId)}/protocols`, { method: 'POST', body: fd });
				const body = await res.json().catch(() => null);
				if (!res.ok) return failure(res.status, `Upload failed — ${body?.message ?? res.status}`, body ?? undefined);
				return ok({ protocolId: body?.data?.opentronsProtocolId ?? null });
			}

			const robotForm = new FormData();
			robotForm.append('files', mainFile, mainFile.name);
			for (const sf of supportFiles) robotForm.append('files', sf, sf.name);
			const res = await line.session.robotFetch('/protocols', {
				method: 'POST',
				headers: MULTIPART_VERSION,
				body: robotForm,
				timeoutMs: 60_000
			});
			return answer(res, 'Upload failed', (data) => ok({ protocolId: data?.data?.id ?? null }));
		},
		delete: async (form) => {
			const protocolId = form.get('protocolId')?.toString();
			if (!protocolId) return failure(400, 'protocolId required');
			return answer(await send(line, 'DELETE', `/protocols/${enc(protocolId)}`), 'Delete failed');
		}
	};
}

// ── protocol detail ─────────────────────────────────────────────────────────

export async function loadProtocol(line: CloneLine, protocolId: string) {
	const c = line.client as any;
	let protocol: any = null;
	let analyses: any[] = [];
	let latest: any = null;
	let online = true;
	let notFound = false;
	try {
		const detail = await c.GET('/protocols/{protocolId}', { params: { path: { protocolId } } });
		if (detail.error !== undefined) {
			if (detail.response.status === 404) notFound = true;
			online = false;
		} else {
			protocol = detail.data?.data ?? null;
		}
		if (!notFound) ({ analyses, latest } = await latestAnalysis(line.client, protocolId));
	} catch {
		online = false;
	}
	const [df, inst] = await Promise.all([list(line, '/dataFiles'), list(line, '/instruments')]);
	return {
		notFound,
		online,
		protocol,
		analyses,
		latestAnalysis: latest,
		dataFiles: df.items,
		dataFilesReachable: df.online,
		instruments: inst.items,
		instrumentsReachable: inst.online
	};
}

type RtpParam = {
	variableName: string;
	displayName: string;
	type: 'int' | 'float' | 'bool' | 'str' | 'csv_file';
	default?: number | boolean | string;
	value?: number | boolean | string;
	min?: number;
	max?: number;
	choices?: Array<{ displayName: string; value: number | string }>;
	file?: { id: string; name: string } | null;
};

export function validateRtpValues(
	params: RtpParam[],
	rawValues: Record<string, unknown>
): { values: Record<string, number | boolean | string> } | { error: string } {
	const out: Record<string, number | boolean | string> = {};
	for (const [key, raw] of Object.entries(rawValues)) {
		const p = params.find((x) => x.variableName === key);
		if (!p) return { error: `Unknown runtime parameter: ${key}` };
		if (p.type === 'csv_file') return { error: `CSV parameter ${key} must be submitted via rtpFiles, not rtpValues` };
		if (p.type === 'bool') {
			if (typeof raw !== 'boolean') return { error: `${key}: expected boolean` };
			out[key] = raw;
			continue;
		}
		if (Array.isArray(p.choices)) {
			const allowed = p.choices.map((c) => c.value);
			const coerced = p.type === 'str' ? String(raw) : p.type === 'int' ? parseInt(String(raw), 10) : parseFloat(String(raw));
			if (p.type !== 'str' && !Number.isFinite(coerced as number)) {
				return { error: `${key}: expected ${p.type}, got ${JSON.stringify(raw)}` };
			}
			if (!allowed.some((v) => v === coerced)) return { error: `${key}: value ${JSON.stringify(coerced)} not among allowed choices` };
			out[key] = coerced as number | string;
			continue;
		}
		if (p.type === 'int') {
			const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
			if (!Number.isInteger(n)) return { error: `${key}: expected integer` };
			if (typeof p.min === 'number' && n < p.min) return { error: `${key}: below min ${p.min}` };
			if (typeof p.max === 'number' && n > p.max) return { error: `${key}: above max ${p.max}` };
			out[key] = n;
			continue;
		}
		if (p.type === 'float') {
			const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
			if (!Number.isFinite(n)) return { error: `${key}: expected number` };
			if (typeof p.min === 'number' && n < p.min) return { error: `${key}: below min ${p.min}` };
			if (typeof p.max === 'number' && n > p.max) return { error: `${key}: above max ${p.max}` };
			out[key] = n;
			continue;
		}
		return { error: `${key}: unsupported parameter type ${p.type}` };
	}
	return { values: out };
}

export function validateRtpFiles(
	params: RtpParam[],
	rawFiles: Record<string, unknown>,
	knownFileIds: Set<string>
): { files: Record<string, string> } | { error: string } {
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(rawFiles)) {
		const p = params.find((x) => x.variableName === key);
		if (!p) return { error: `Unknown runtime parameter: ${key}` };
		if (p.type !== 'csv_file') return { error: `${key}: rtpFiles is only valid for csv_file parameters` };
		if (raw === null || raw === '' || raw === undefined) continue; // operator picked "none"
		if (typeof raw !== 'string') return { error: `${key}: expected fileId string` };
		if (knownFileIds.size > 0 && !knownFileIds.has(raw)) return { error: `${key}: CSV file no longer exists; refresh and re-pick` };
		out[key] = raw;
	}
	return { files: out };
}

function parseObject(raw: string, name: string): Record<string, unknown> | CloneOutcome {
	try {
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return failure(400, `${name} must be a JSON object`);
		return parsed as Record<string, unknown>;
	} catch {
		return failure(400, `${name} must be valid JSON`);
	}
}
const isOutcome = (v: unknown): v is CloneOutcome => !!v && typeof v === 'object' && 'type' in (v as any) && ['success', 'failure', 'redirect'].includes((v as any).type);

export function protocolActions(line: CloneLine, protocolId: string): Record<string, CloneAction> {
	return {
		delete: async () => {
			const res = await send(line, 'DELETE', `/protocols/${enc(protocolId)}`);
			if (!res.ok) return answer(res, 'Delete failed');
			return redirectTo(`/opentrons-clone/${line.robotId}/protocols`);
		},
		createRun: async (form) => {
			const rtpValuesRaw = form.get('rtpValues')?.toString() ?? '';
			const rtpFilesRaw = form.get('rtpFiles')?.toString() ?? '';
			const offsetsRaw = form.get('offsets')?.toString() ?? '';

			let rtpValuesParsed: Record<string, unknown> = {};
			let rtpFilesParsed: Record<string, unknown> = {};
			if (rtpValuesRaw) {
				const v = parseObject(rtpValuesRaw, 'rtpValues');
				if (isOutcome(v)) return v;
				rtpValuesParsed = v;
			}
			if (rtpFilesRaw) {
				const v = parseObject(rtpFilesRaw, 'rtpFiles');
				if (isOutcome(v)) return v;
				rtpFilesParsed = v;
			}

			type LegacyOffset = { definitionUri: string; location: { slotName: string }; vector: { x: number; y: number; z: number } };
			const labwareOffsets: LegacyOffset[] = [];
			if (offsetsRaw) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(offsetsRaw);
				} catch {
					return failure(400, 'offsets must be valid JSON');
				}
				if (!Array.isArray(parsed)) return failure(400, 'offsets must be a JSON array');
				for (const [i, raw] of parsed.entries()) {
					if (raw === null || typeof raw !== 'object') return failure(400, `offsets[${i}] must be an object`);
					const o = raw as Record<string, unknown>;
					const definitionUri = typeof o.definitionUri === 'string' ? o.definitionUri : '';
					const loc = o.location as Record<string, unknown> | undefined;
					const slotName = loc && typeof loc.slotName === 'string' ? loc.slotName : '';
					const vec = o.vector as Record<string, unknown> | undefined;
					const x = vec && typeof vec.x === 'number' ? vec.x : NaN;
					const y = vec && typeof vec.y === 'number' ? vec.y : NaN;
					const z = vec && typeof vec.z === 'number' ? vec.z : NaN;
					if (!definitionUri || !slotName || [x, y, z].some(Number.isNaN)) {
						return failure(400, `offsets[${i}] requires definitionUri, location.slotName, and numeric vector.x/y/z`);
					}
					labwareOffsets.push({ definitionUri, location: { slotName }, vector: { x, y, z } });
				}
			}

			let rtpValues: Record<string, number | boolean | string> = {};
			let rtpFiles: Record<string, string> = {};
			if (Object.keys(rtpValuesParsed).length > 0 || Object.keys(rtpFilesParsed).length > 0) {
				let params: RtpParam[] = [];
				try {
					const { latest } = await latestAnalysis(line.client, protocolId);
					params = (latest?.runTimeParameters ?? []) as RtpParam[];
				} catch {
					return failure(502, 'Could not fetch analysis to validate parameters');
				}
				const vResult = validateRtpValues(params, rtpValuesParsed);
				if ('error' in vResult) return failure(400, vResult.error);
				rtpValues = vResult.values;

				let knownFileIds = new Set<string>();
				const df = await list(line, '/dataFiles');
				if (df.online) knownFileIds = new Set<string>(df.items.map((f: { id: string }) => f.id));
				const fResult = validateRtpFiles(params, rtpFilesParsed, knownFileIds);
				if ('error' in fResult) return failure(400, fResult.error);
				rtpFiles = fResult.files;
			}

			const body: Record<string, unknown> = { protocolId };
			if (Object.keys(rtpValues).length > 0) body.runTimeParameterValues = rtpValues;
			if (Object.keys(rtpFiles).length > 0) body.runTimeParameterFiles = rtpFiles;
			if (labwareOffsets.length > 0) body.labwareOffsets = labwareOffsets;

			// Never auto-retried: a lost answer on the direct line comes back 502.
			const res = await post(line, '/runs', { data: body }, 15_000);
			if (!res.ok) return answer(res, 'Run create failed');
			const data = await res.json().catch(() => null);
			const runId = data?.data?.id ?? null;
			if (runId) return redirectTo(`/opentrons-clone/${line.robotId}/runs/${runId}`);
			return failure(500, 'Run created but no id returned');
		}
	};
}

// ── runs ────────────────────────────────────────────────────────────────────

export async function loadRuns(line: CloneLine, limit: number) {
	const pageLength = Math.min(limit, 100);
	const { online, items } = await list(line, '/runs', { pageLength });
	return { online, runs: [...items].sort(newestFirst) };
}

export async function loadRun(line: CloneLine, runId: string, cmdLimit: number) {
	const c = line.client as any;
	const p = { params: { path: { runId } } };
	let run: any = null;
	let currentState: any = null;
	let commands: any[] = [];
	let commandErrors: any[] = [];
	let online = true;
	let notFound = false;
	try {
		const [runRes, stateRes, cmdRes, errRes] = await Promise.all([
			c.GET('/runs/{runId}', p),
			c.GET('/runs/{runId}/currentState', p),
			c.GET('/runs/{runId}/commands', { params: { path: { runId }, query: { pageLength: cmdLimit } } }),
			c.GET('/runs/{runId}/commandErrors', p)
		]);
		if (runRes.error !== undefined) {
			if (runRes.response.status === 404) notFound = true;
			online = false;
		} else {
			run = runRes.data?.data ?? null;
		}
		if (stateRes.error === undefined) currentState = stateRes.data?.data ?? null;
		if (cmdRes.error === undefined) commands = cmdRes.data?.data ?? [];
		if (errRes.error === undefined) commandErrors = errRes.data?.data ?? [];
	} catch {
		online = false;
	}
	return { notFound, online, run, currentState, commands, commandErrors };
}

const VALID_RUN_ACTIONS = ['play', 'pause', 'stop', 'resume-from-recovery'] as const;

export function runActions(line: CloneLine, runId: string): Record<string, CloneAction> {
	return {
		action: async (form) => {
			const actionType = form.get('actionType')?.toString();
			if (!actionType || !(VALID_RUN_ACTIONS as readonly string[]).includes(actionType)) {
				return failure(400, `Invalid actionType: ${actionType}`);
			}
			return answer(await post(line, `/runs/${enc(runId)}/actions`, { data: { actionType } }, 10_000), `Action ${actionType} failed`, () =>
				ok({ actionType })
			);
		},
		applyOffset: async (form) => {
			const definitionUri = form.get('definitionUri')?.toString()?.trim();
			const slotName = form.get('slotName')?.toString()?.trim();
			const x = parseFloat(form.get('x')?.toString() ?? '0');
			const y = parseFloat(form.get('y')?.toString() ?? '0');
			const z = parseFloat(form.get('z')?.toString() ?? '0');
			if (!definitionUri || !slotName || [x, y, z].some(Number.isNaN)) {
				return failure(400, 'definitionUri, slotName, and numeric x/y/z are required');
			}
			const res = await post(line, `/runs/${enc(runId)}/labware_offsets`, { data: { definitionUri, location: { slotName }, vector: { x, y, z } } }, 10_000);
			return answer(res, 'Apply offset failed', () => ok({ message: `Offset applied for ${definitionUri} @ ${slotName}` }));
		},
		delete: async () => {
			const res = await send(line, 'DELETE', `/runs/${enc(runId)}`);
			if (!res.ok) return answer(res, 'Delete failed');
			return redirectTo(`/opentrons-clone/${line.robotId}/runs`);
		}
	};
}

// ── labware / data files / settings ─────────────────────────────────────────

export async function loadLabware(line: CloneLine) {
	const { online, items } = await list(line, '/labwareOffsets');
	return { online, offsets: items };
}

export async function loadDataFiles(line: CloneLine) {
	const { online, items } = await list(line, '/dataFiles');
	return { online, dataFiles: items };
}

export function dataFilesActions(line: CloneLine): Record<string, CloneAction> {
	return {
		uploadDataFile: async (form) => {
			const file = form.get('file');
			if (!(file instanceof File) || file.size === 0) return failure(400, 'file is required');
			const out = new FormData();
			out.append('file', file, file.name);
			// Multipart: direct only — on the queue line robotFetch answers 409 "needs Tailscale".
			const res = await line.session.robotFetch('/dataFiles', { method: 'POST', headers: MULTIPART_VERSION, body: out, timeoutMs: 60_000 });
			return answer(res, 'Upload failed', () => ok({ message: `Uploaded ${file.name}` }));
		},
		deleteDataFile: async (form) => {
			const id = form.get('id')?.toString();
			if (!id) return failure(400, 'id required');
			return answer(await send(line, 'DELETE', `/dataFiles/${enc(id)}`), 'Delete failed');
		},
		setClientData: async (form) => {
			const key = form.get('key')?.toString()?.trim();
			const valueRaw = form.get('value')?.toString() ?? '';
			if (!key) return failure(400, 'key required');
			let parsed: unknown;
			try {
				parsed = JSON.parse(valueRaw);
			} catch {
				return failure(400, 'value must be valid JSON (object expected)');
			}
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return failure(400, 'value must be a JSON object (OT-2 /clientData requires a dict)');
			}
			const res = await send(line, 'PUT', `/clientData/${enc(key)}`, { data: parsed }, 5_000);
			return answer(res, 'Client data set failed', () => ok({ message: `Set clientData[${key}]` }));
		},
		deleteClientData: async (form) => {
			const key = form.get('key')?.toString()?.trim();
			const res = await send(line, 'DELETE', key ? `/clientData/${enc(key)}` : '/clientData', undefined, 5_000);
			return answer(res, 'Client data delete failed', () => ok({ message: key ? `Deleted clientData[${key}]` : 'Cleared all clientData' }));
		}
	};
}

/** GET /clientData/:key — the lookup button (was /api/opentrons-clone/…/client-data/:key). */
export async function lookupClientData(line: CloneLine, key: string): Promise<{ status: number; body: unknown }> {
	const res = await line.session.robotFetch(`/clientData/${enc(key)}`, { timeoutMs: 5_000 });
	return { status: res.status, body: await res.json().catch(() => null) };
}

export async function loadSettings(line: CloneLine) {
	const c = line.client;
	const [settings, resetOptions, errorRecovery, networking, systemTime] = await Promise.all([
		safeGet<any>(c, '/settings'),
		safeGet<any>(c, '/settings/reset/options'),
		safeGet<any>(c, '/errorRecovery/settings'),
		safeGet<any>(c, '/networking/status'),
		safeGet<any>(c, '/system/time')
	]);
	return {
		online: settings !== null || networking !== null,
		settings: (settings as any)?.settings ?? [],
		resetOptions: (resetOptions as any)?.options ?? [],
		errorRecoveryEnabled: (errorRecovery as any)?.data?.enabled ?? null,
		networking: networking ?? null,
		systemTime: (systemTime as any)?.data?.systemTime ?? null
	};
}

export function settingsActions(line: CloneLine): Record<string, CloneAction> {
	return {
		updateSetting: async (form) => {
			const id = form.get('id')?.toString();
			const value = form.get('value')?.toString() === 'true';
			if (!id) return failure(400, 'setting id required');
			return answer(await post(line, '/settings', { id, value }, 10_000), 'Setting update failed', () => ok({ message: `${id} → ${value}` }));
		},
		resetSettings: async (form) => {
			const categories = form.getAll('category').map((c) => c.toString()).filter(Boolean);
			if (categories.length === 0) return failure(400, 'pick at least one category to reset');
			const body: Record<string, boolean> = {};
			for (const c of categories) body[c] = true;
			return answer(await post(line, '/settings/reset', body, 10_000), 'Reset failed', () => ok({ message: `Reset: ${categories.join(', ')}` }));
		},
		errorRecovery: async (form) => {
			const enabled = form.get('enabled')?.toString() === 'true';
			return answer(await send(line, 'PATCH', '/errorRecovery/settings', { data: { enabled } }), 'Error recovery toggle failed', () =>
				ok({ message: `Error recovery ${enabled ? 'enabled' : 'disabled'}` })
			);
		},
		systemTime: async (form) => {
			const iso = form.get('iso')?.toString() || new Date().toISOString();
			return answer(await send(line, 'PUT', '/system/time', { data: { systemTime: iso } }), 'System time update failed', () =>
				ok({ message: `System time set to ${iso}` })
			);
		}
	};
}

// ── robots list (health, was the SSE poller) ────────────────────────────────

const ACTIVE_RUN = ['running', 'paused', 'finishing', 'awaiting-recovery'];

/** The daemon-heartbeat health the page server load returns (shape of $lib/server/opentrons/health RobotHealth). */
export interface HeartbeatHealth {
	status: 'ready' | 'busy' | 'hung' | 'offline';
	label: string;
	detail: string;
	bridgeOnline: boolean;
	serverOk: boolean;
	protocolRun: string | null;
	lastBeatMsAgo: number | null;
}

/**
 * Queue-line robots: the card shows the daemon heartbeat (the with-no-browser
 * truth, §7.6) in the same shape readRobotHealth gives for a direct robot.
 * Versions and the run id aren't in the heartbeat, so they show '—'.
 */
export function healthFromHeartbeat(h: HeartbeatHealth): Awaited<ReturnType<typeof readRobotHealth>> {
	const run = h.protocolRun && ACTIVE_RUN.includes(String(h.protocolRun).toLowerCase()) ? String(h.protocolRun) : null;
	return {
		isOnline: h.bridgeOnline && h.serverOk,
		apiVersion: null,
		firmwareVersion: null,
		currentRunId: run ? 'heartbeat' : null,
		currentRunStatus: run,
		responseTimeMs: null,
		errorMessage: h.status === 'offline' || h.status === 'hung' ? `${h.label} — ${h.detail} (daemon heartbeat)` : null
	};
}

/** What the retired health poller computed per robot, read from this browser. */
export async function readRobotHealth(robotFetch: CloneLine['session']['robotFetch']) {
	const t0 = Date.now();
	const state = {
		isOnline: false,
		apiVersion: null as string | null,
		firmwareVersion: null as string | null,
		currentRunId: null as string | null,
		currentRunStatus: null as string | null,
		responseTimeMs: null as number | null,
		errorMessage: null as string | null
	};
	try {
		const res = await robotFetch('/health', { timeoutMs: 5_000 });
		state.responseTimeMs = Date.now() - t0;
		const health = await res.json().catch(() => null);
		if (!res.ok) {
			state.errorMessage = health?.message ?? `HTTP ${res.status}`;
			return state;
		}
		state.isOnline = true;
		state.apiVersion = health?.api_version ?? null;
		state.firmwareVersion = health?.fw_version ?? null;
		try {
			const runsRes = await robotFetch('/runs?pageLength=1', { timeoutMs: 5_000 });
			if (runsRes.ok) {
				const latest = ((await runsRes.json())?.data ?? [])[0];
				if (latest && ACTIVE_RUN.includes(latest.status)) {
					state.currentRunId = latest.id;
					state.currentRunStatus = latest.status;
				}
			}
		} catch {
			/* non-critical */
		}
	} catch (e) {
		state.responseTimeMs = Date.now() - t0;
		state.errorMessage = e instanceof Error ? e.message : 'Unknown error';
	}
	return state;
}
