/**
 * BIMS API v1 — a held reader's Wi-Fi (firmware v109+). Contract: docs/BIMS-API-V1.md, "Readers".
 * The same device calls as the operator panel (/api/spu/[spuId]/wifi, $lib/server/spu-wifi).
 *
 *   GET  /api/v1/readers/{serial}/wifi?holderRef=h_…
 *        -> 200 { online, supported, status, scan, error }
 *   POST /api/v1/readers/{serial}/wifi
 *        { holderRef, action: 'scan' }                              -> 200 { seq } | 409 { error } | 502 { error }
 *        { holderRef, action: 'connect', ssid, password, security } -> 200 { seq } | 400 | 409 | 502 { error }
 *   404 { reason: 'not_found' } unless this holder holds the reader.
 *
 * The password is forwarded to the device through Particle only. It is never
 * stored, logged, audited, journaled or returned, in any message. Scan results
 * are returned live and never stored. A Wi-Fi change is journaled without the
 * network name (READER-01: a network name can place a home).
 */
import { requireApp } from '$lib/server/bims-api/auth';
import { ApiError, guarded, readJsonBody, requireHolderRef, requireReaderSerial, respond } from '$lib/server/bims-api/http';
import { enforceRateLimit } from '$lib/server/bims-api/rate-limit';
import { appMessage } from '$lib/server/bims-api/reader-rules';
import { heldReader, journalWifiChange } from '$lib/server/bims-api/readers';
import { connectDB } from '$lib/server/db';
import { getDevice } from '$lib/server/particle';
import { readWifi, replaceAndSwitch, requestScan, validateCredentials } from '$lib/server/spu-wifi';
import type { RequestHandler } from './$types';

const NOT_FOUND = { reason: 'not_found' };
const NO_DEVICE = 'This reader is not connected to the Bioscale cloud yet.';
const UNREACHABLE = 'Could not reach the reader.';

const msg = (e: unknown) => appMessage(e instanceof Error ? e.message : String(e));

export const GET: RequestHandler = ({ request, params, url }) =>
	guarded('reader_wifi', async () => {
		const app = requireApp(request);
		const serial = requireReaderSerial(params.serial);
		const holderRef = requireHolderRef(url.searchParams.get('holderRef'));
		await connectDB();
		await enforceRateLimit('reader_wifi', app, holderRef);
		const doc = await heldReader(serial, holderRef);
		if (!doc) return respond(NOT_FOUND, 404);
		const deviceId = doc.particleLink?.particleDeviceId;
		if (!deviceId) return respond({ online: false, supported: null, status: null, scan: null, error: NO_DEVICE });

		let online = false;
		try {
			const d = await getDevice(deviceId);
			online = !!(d.online ?? d.connected);
		} catch (e) {
			return respond({ online: false, supported: null, status: null, scan: null, error: msg(e) });
		}
		if (!online) return respond({ online, supported: null, status: null, scan: null, error: null });

		try {
			const w = await readWifi(deviceId);
			return respond({ online, ...w, error: w.error === null ? null : appMessage(w.error) });
		} catch (e) {
			return respond({ online, supported: null, status: null, scan: null, error: msg(e) });
		}
	});

const FIELDS = ['holderRef', 'action', 'ssid', 'password', 'security'];

export const POST: RequestHandler = ({ request, params }) =>
	guarded('reader_wifi_post', async () => {
		const app = requireApp(request);
		const serial = requireReaderSerial(params.serial);
		const body = await readJsonBody(request, FIELDS, `Only ${FIELDS.join(', ')} are accepted in the body`);
		const holderRef = requireHolderRef(body.holderRef);
		const action = body.action;
		if (action !== 'scan' && action !== 'connect') throw new ApiError(400, 'Unknown action');
		await connectDB();
		await enforceRateLimit(action === 'scan' ? 'reader_scan' : 'reader_connect', app, holderRef);
		const doc = await heldReader(serial, holderRef);
		if (!doc) return respond(NOT_FOUND, 404);
		const deviceId = doc.particleLink?.particleDeviceId;
		if (!deviceId) return respond({ error: NO_DEVICE }, 409);

		if (action === 'scan') {
			let r;
			try {
				r = await requestScan(deviceId);
			} catch {
				return respond({ error: UNREACHABLE }, 502);
			}
			return r.ok ? respond({ seq: r.seq }) : respond({ error: appMessage(r.error) }, 409);
		}

		const password = typeof body.password === 'string' ? body.password : '';
		const v = validateCredentials(body.ssid, body.password, body.security);
		if (!v.ok) return respond({ error: appMessage(v.error) }, 400); // fixed sentences; none repeats the input
		let r;
		try {
			r = await replaceAndSwitch(deviceId, v.ssid, v.password, v.security);
		} catch {
			// The thrown text is never returned: it could in principle carry what was sent.
			return respond({ error: UNREACHABLE }, 502);
		}
		if (!r.ok) return respond({ error: appMessage(r.error, password) }, 409);
		await journalWifiChange(doc, app);
		return respond({ seq: r.seq });
	});
