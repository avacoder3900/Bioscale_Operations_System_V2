/**
 * SPU Wi-Fi scan + switch (firmware v109+).
 *
 * Device contract (brevitest-device feat/v109-wifi-scan, "WI-FI SCAN & SWITCH" section):
 *   set_service("wifi_scan")                       -> scan seq (>0) | -2 busy | -3 radio off | -1 firmware < v109
 *   set_wifi_credentials("ssid:::password:::sec")  -> switch seq (>0) | -2 bad arg | -4 busy | -5 rejected
 *                                                      (0 = pre-v109 firmware: saved, but no progress reporting)
 *   variable wifi_scan   {"v":1,"seq":N,"fw":109,"n":[["ssid",rssi,security,channel],...],"more":0|1} or {"seq":N,"error":"..."}
 *   variable wifi_status {"v":1,"ready","ssid","rssi","cloud","cell","sw","swseq","target","scanseq","saved":[...]}
 *
 * New networks are ADDED on the device; previously saved networks stay as fallback.
 * The password is passed straight through to Particle and is never stored or logged here.
 */
import { callFunction, getVariable } from '$lib/server/particle';

/** Device OS WLanSecurityType. */
export const WIFI_SECURITY_LABELS: Record<number, string> = {
	0: 'Open',
	1: 'WEP',
	2: 'WPA',
	3: 'WPA2',
	4: 'WPA Enterprise',
	5: 'WPA2 Enterprise',
	6: 'WPA3'
};
/** Enterprise networks need a username/certificate, which this flow does not support. */
export const UNSUPPORTED_SECURITY = new Set([4, 5]);

export const SWITCH_STATES: Record<number, string> = {
	0: 'none',
	1: 'queued',
	2: 'connecting',
	3: 'joined',
	4: 'joined_other',
	5: 'failed'
};

export interface WifiNetwork {
	ssid: string;
	rssi: number;
	security: number;
	securityLabel: string;
	channel: number;
	supported: boolean;
}

export interface WifiScan {
	seq: number;
	networks: WifiNetwork[];
	truncated: boolean;
	error: string | null;
}

export interface WifiStatus {
	firmware: number | null;
	radioOn: boolean;
	ready: boolean;
	ssid: string | null;
	rssi: number | null;
	cloud: boolean;
	cellular: boolean;
	switchState: string;
	switchSeq: number;
	target: string | null;
	scanSeq: number;
	saved: string[];
}

function parseJson(raw: unknown): any {
	if (typeof raw !== 'string') return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

export function parseScan(raw: unknown): WifiScan | null {
	const j = parseJson(raw);
	if (!j || typeof j.seq !== 'number') return null;
	const networks: WifiNetwork[] = Array.isArray(j.n)
		? j.n
				.filter((r: unknown) => Array.isArray(r) && typeof r[0] === 'string')
				.map((r: any[]) => {
					const security = Number(r[2]);
					return {
						ssid: r[0],
						rssi: Number(r[1]),
						security,
						securityLabel: WIFI_SECURITY_LABELS[security] ?? `Secured (${security})`,
						channel: Number(r[3]),
						supported: !UNSUPPORTED_SECURITY.has(security)
					};
				})
		: [];
	return { seq: j.seq, networks, truncated: j.more === 1, error: typeof j.error === 'string' ? j.error : null };
}

export function parseStatus(raw: unknown): WifiStatus | null {
	const j = parseJson(raw);
	if (!j || typeof j.v !== 'number') return null;
	return {
		firmware: typeof j.fw === 'number' ? j.fw : null,
		radioOn: j.on === 1,
		ready: j.ready === 1,
		ssid: j.ready === 1 && j.ssid ? String(j.ssid) : null,
		rssi: j.ready === 1 && typeof j.rssi === 'number' ? j.rssi : null,
		cloud: j.cloud === 1,
		cellular: j.cell === 1,
		switchState: SWITCH_STATES[j.sw] ?? 'none',
		switchSeq: typeof j.swseq === 'number' ? j.swseq : 0,
		target: j.target ? String(j.target) : null,
		scanSeq: typeof j.scanseq === 'number' ? j.scanseq : 0,
		saved: Array.isArray(j.saved) ? j.saved.map(String) : []
	};
}

const isMissingVariable = (msg: string) => /variable not found|not found/i.test(msg);

/** Read both Wi-Fi variables. `supported: false` means the device runs firmware older than v109. */
export async function readWifi(deviceId: string): Promise<{
	supported: boolean;
	status: WifiStatus | null;
	scan: WifiScan | null;
	error: string | null;
}> {
	const [st, sc] = await Promise.allSettled([
		getVariable(deviceId, 'wifi_status'),
		getVariable(deviceId, 'wifi_scan')
	]);
	const errOf = (r: PromiseSettledResult<any>) =>
		r.status === 'rejected' ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : null;
	const stErr = errOf(st);
	if (stErr && isMissingVariable(stErr)) {
		return { supported: false, status: null, scan: null, error: null };
	}
	return {
		supported: true,
		status: st.status === 'fulfilled' ? parseStatus(st.value?.result) : null,
		scan: sc.status === 'fulfilled' ? parseScan(sc.value?.result) : null,
		error: stErr ?? errOf(sc)
	};
}

export async function requestScan(deviceId: string): Promise<{ ok: true; seq: number } | { ok: false; error: string }> {
	const { return_value: rv } = await callFunction(deviceId, 'set_service', 'wifi_scan');
	if (rv > 0) return { ok: true, seq: rv };
	if (rv === -1) return { ok: false, error: 'This SPU runs firmware older than v109, which cannot scan for Wi-Fi.' };
	if (rv === -2) return { ok: false, error: 'SPU is busy (running a test or other routine). Try again when it is idle.' };
	if (rv === -3) return { ok: false, error: 'The SPU has its Wi-Fi radio turned off.' };
	return { ok: false, error: `Scan refused by the device (code ${rv}).` };
}

export function validateCredentials(
	ssid: unknown,
	password: unknown,
	security: unknown
): { ok: true; ssid: string; password: string; security: number } | { ok: false; error: string } {
	if (typeof ssid !== 'string' || ssid.length === 0) return { ok: false, error: 'Select a network.' };
	if (new TextEncoder().encode(ssid).length > 32) return { ok: false, error: 'Network name is too long.' };
	if (ssid.includes(':::')) return { ok: false, error: 'Network name contains an unsupported sequence (":::").' };
	const sec = Number(security);
	if (!Number.isInteger(sec) || sec < 0 || sec > 99) return { ok: false, error: 'Unknown network security type. Re-scan.' };
	if (UNSUPPORTED_SECURITY.has(sec)) return { ok: false, error: 'Enterprise Wi-Fi networks are not supported.' };
	const pw = typeof password === 'string' ? password : '';
	if (sec === 0 && pw.length > 0) return { ok: false, error: 'This is an open network; leave the password empty.' };
	if (sec !== 0 && pw.length === 0) return { ok: false, error: 'Password is required for this network.' };
	if (sec >= 2 && (pw.length < 8 || pw.length > 63)) return { ok: false, error: 'WPA passwords are 8–63 characters.' };
	if (pw.length > 64) return { ok: false, error: 'Password is too long.' };
	return { ok: true, ssid, password: pw, security: sec };
}

export async function requestSwitch(
	deviceId: string,
	ssid: string,
	password: string,
	security: number
): Promise<{ ok: true; seq: number | null } | { ok: false; error: string }> {
	// Security always goes last, so a password that itself contains ":::" still parses correctly.
	const { return_value: rv } = await callFunction(deviceId, 'set_wifi_credentials', `${ssid}:::${password}:::${security}`);
	if (rv > 0) return { ok: true, seq: rv };
	if (rv === 0) return { ok: true, seq: null }; // pre-v109: saved + connect, no progress reporting
	if (rv === -2) return { ok: false, error: 'The device rejected the network name or password format.' };
	if (rv === -4) return { ok: false, error: 'SPU is busy (running a test or other routine). Try again when it is idle.' };
	if (rv === -5) return { ok: false, error: 'Device OS refused to save these credentials.' };
	return { ok: false, error: `Device returned code ${rv}.` };
}
