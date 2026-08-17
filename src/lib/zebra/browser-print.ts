/**
 * Minimal client for the Zebra Browser Print local agent.
 *
 * Why this exists: BIMS runs on Vercel and cannot reach the lab LAN, so the
 * server can never talk to the ZT230 directly. Zebra's free Browser Print
 * agent runs on the operator's PC, discovers printers it can reach (USB, or
 * WiFi/Ethernet on the same LAN), and exposes them to web pages over a tiny
 * localhost HTTP API. We talk to that API directly rather than bundling
 * Zebra's licensed BrowserPrint-*.js — it is four endpoints.
 *
 * Endpoints (agent 1.x/3.x): GET /available, GET /default?type=printer,
 * POST /write {device, data}, POST /read {device}. HTTPS on :9101 (Zebra's
 * self-signed cert, needed by some browsers for https pages), HTTP on :9100.
 * Chrome exempts http://localhost from mixed-content blocking, so the http
 * fallback works from the https BIMS origin. On first use the agent pops a
 * native dialog asking the operator to allow this site's origin — until they
 * click Accept every request rejects.
 *
 * Browser-only module (uses fetch/AbortController); do not import server-side.
 */

export interface BrowserPrintDevice {
	name: string;
	uid: string;
	connection: string; // 'usb' | 'network' | 'driver' | 'bluetooth'
	deviceType: string; // 'printer'
	version?: number;
	provider?: string;
	manufacturer?: string;
}

export interface BrowserPrintStatus {
	reachable: boolean;
	baseUrl: string | null;
	error?: string;
}

const CANDIDATE_BASES = ['https://localhost:9101', 'http://localhost:9100'];
let cachedBase: string | null = null;

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), ms);
	try {
		return await p(ctl.signal);
	} finally {
		clearTimeout(t);
	}
}

/** Find a responding agent base URL. Cached after the first success. */
export async function detectAgent(force = false): Promise<BrowserPrintStatus> {
	if (cachedBase && !force) return { reachable: true, baseUrl: cachedBase };
	let lastErr = '';
	for (const base of CANDIDATE_BASES) {
		try {
			const res = await withTimeout(
				(signal) => fetch(`${base}/available`, { method: 'GET', signal, cache: 'no-store' }),
				2500
			);
			if (res.ok) {
				cachedBase = base;
				return { reachable: true, baseUrl: base };
			}
			lastErr = `${base} → HTTP ${res.status}`;
		} catch (e) {
			lastErr = `${base} → ${e instanceof Error ? e.message : String(e)}`;
		}
	}
	cachedBase = null;
	return { reachable: false, baseUrl: null, error: lastErr || 'Browser Print agent not reachable' };
}

/** All printers the agent can see. */
export async function listPrinters(): Promise<BrowserPrintDevice[]> {
	const st = await detectAgent();
	if (!st.reachable || !st.baseUrl) throw new Error(st.error ?? 'Browser Print agent not reachable');
	const res = await withTimeout((signal) => fetch(`${st.baseUrl}/available`, { signal, cache: 'no-store' }), 5000);
	if (!res.ok) throw new Error(`Browser Print /available → HTTP ${res.status}`);
	const body = (await res.json()) as { printer?: BrowserPrintDevice[] } | BrowserPrintDevice[];
	const list = Array.isArray(body) ? body : (body.printer ?? []);
	return list.filter((d) => (d.deviceType ?? 'printer') === 'printer');
}

/** The agent's configured default printer, if any. */
export async function defaultPrinter(): Promise<BrowserPrintDevice | null> {
	const st = await detectAgent();
	if (!st.reachable || !st.baseUrl) return null;
	try {
		const res = await withTimeout((signal) => fetch(`${st.baseUrl}/default?type=printer`, { signal, cache: 'no-store' }), 5000);
		if (!res.ok) return null;
		const txt = await res.text();
		if (!txt.trim()) return null;
		return JSON.parse(txt) as BrowserPrintDevice;
	} catch {
		return null;
	}
}

/**
 * Send raw ZPL to a printer. Resolves when the agent has accepted the job
 * (i.e. it reached the printer's input buffer) — NOT when the labels have
 * physically printed. Rejects on agent/transport errors.
 */
export async function sendZpl(device: BrowserPrintDevice, zpl: string): Promise<void> {
	const st = await detectAgent();
	if (!st.reachable || !st.baseUrl) throw new Error(st.error ?? 'Browser Print agent not reachable');
	const payload = JSON.stringify({
		device: {
			name: device.name,
			uid: device.uid,
			connection: device.connection,
			deviceType: device.deviceType ?? 'printer',
			version: device.version ?? 0,
			provider: device.provider ?? 'com.zebra.ds.webdriver.desktop.provider.DefaultDeviceProvider',
			manufacturer: device.manufacturer ?? 'Zebra Technologies'
		},
		data: zpl
	});
	// No explicit Content-Type: a text/plain body is a CORS "simple request",
	// which is what the agent expects (Zebra's own SDK does the same).
	const res = await withTimeout(
		(signal) => fetch(`${st.baseUrl}/write`, { method: 'POST', body: payload, signal }),
		30_000
	);
	if (!res.ok) {
		const txt = await res.text().catch(() => '');
		throw new Error(`Browser Print /write → HTTP ${res.status}${txt ? `: ${txt}` : ''}`);
	}
}

/**
 * Ask the printer for its host status (~HS) and parse the bits we care about.
 * Best-effort: returns null if the agent/printer doesn't answer.
 */
export async function queryHostStatus(device: BrowserPrintDevice): Promise<{ raw: string; paperOut: boolean; paused: boolean; headOpen: boolean; labelsRemainingInBatch: number } | null> {
	const st = await detectAgent();
	if (!st.reachable || !st.baseUrl) return null;
	try {
		await sendZpl(device, '~HS');
		const res = await withTimeout(
			(signal) => fetch(`${st.baseUrl}/read`, { method: 'POST', body: JSON.stringify({ device }), signal }),
			5000
		);
		if (!res.ok) return null;
		const raw = await res.text();
		// ~HS → three STX…ETX lines; line 1 fields: aaa,b,c,dddd,eee,f,g,h,iii,j,k,l
		//   b = paper out (1), c = pause (1), iii = labels remaining in batch
		// line 2 fields: mmm,n,o,p,q,r,s,t,uuuuuuuu,v,www — o = head up (1)
		const lines = raw.replace(/\x02/g, '').split(/\x03|\r?\n/).map((l) => l.trim()).filter(Boolean);
		const l1 = (lines[0] ?? '').split(',');
		const l2 = (lines[1] ?? '').split(',');
		return {
			raw,
			paperOut: l1[1] === '1',
			paused: l1[2] === '1',
			labelsRemainingInBatch: Number(l1[8] ?? 0) || 0,
			headOpen: l2[2] === '1'
		};
	} catch {
		return null;
	}
}

/** Human-friendly one-liner for a device row. */
export function describeDevice(d: BrowserPrintDevice): string {
	return `${d.name}${d.connection ? ` (${d.connection}${d.uid && d.connection === 'network' ? ` ${d.uid}` : ''})` : ''}`;
}
