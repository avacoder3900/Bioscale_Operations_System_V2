import { json, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu } from '$lib/server/db';
import { getDevice } from '$lib/server/particle';
import { readWifi, requestScan, requestSwitch, validateCredentials } from '$lib/server/spu-wifi';
import { appendSpuJournal } from '$lib/server/spu-journal';
import type { RequestHandler } from './$types';

/**
 * Wi-Fi panel on /spu/[spuId]/diagnostics (firmware v109+).
 *   GET  -> { online, supported, status, scan, error }   (polled by the panel)
 *   POST { action: 'scan' }                               -> { seq }
 *   POST { action: 'connect', ssid, password, security }  -> { seq }
 * The password is forwarded to the device through Particle only; it is never stored,
 * journaled, audited or echoed back.
 */

async function deviceIdFor(spuId: string): Promise<{ deviceId: string; udi: string }> {
	await connectDB();
	const spu = (await Spu.findById(spuId, { udi: 1, 'particleLink.particleDeviceId': 1 }).lean()) as any;
	if (!spu) throw error(404, 'SPU not found');
	const deviceId = spu.particleLink?.particleDeviceId;
	if (!deviceId) throw error(400, 'No Particle device is linked to this SPU');
	return { deviceId, udi: spu.udi };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const GET: RequestHandler = async ({ params, locals }) => {
	requirePermission(locals.user, 'spu:read');
	const { deviceId } = await deviceIdFor(params.spuId);

	let online = false;
	try {
		const d = await getDevice(deviceId);
		online = !!(d.online ?? d.connected);
	} catch (e) {
		return json({ online: false, supported: null, status: null, scan: null, error: msg(e) });
	}
	if (!online) return json({ online, supported: null, status: null, scan: null, error: null });

	try {
		return json({ online, ...(await readWifi(deviceId)) });
	} catch (e) {
		return json({ online, supported: null, status: null, scan: null, error: msg(e) });
	}
};

export const POST: RequestHandler = async ({ params, locals, request }) => {
	requirePermission(locals.user, 'spu:write');
	const { deviceId, udi } = await deviceIdFor(params.spuId);
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') throw error(400, 'JSON body required');

	if (body.action === 'scan') {
		try {
			const r = await requestScan(deviceId);
			return r.ok ? json({ seq: r.seq }) : json({ error: r.error }, { status: 409 });
		} catch (e) {
			return json({ error: `Could not reach the SPU: ${msg(e)}` }, { status: 502 });
		}
	}

	if (body.action === 'connect') {
		const v = validateCredentials(body.ssid, body.password, body.security);
		if (!v.ok) return json({ error: v.error }, { status: 400 });
		let r;
		try {
			r = await requestSwitch(deviceId, v.ssid, v.password, v.security);
		} catch (e) {
			return json({ error: `Could not reach the SPU: ${msg(e)}` }, { status: 502 });
		}
		if (!r.ok) return json({ error: r.error }, { status: 409 });

		// Journal (writes the AuditLog too). Network name only — never the password.
		const actor = { _id: locals.user!._id, username: locals.user!.username };
		await appendSpuJournal(
			params.spuId,
			`Wi-Fi: switched ${udi} to network "${v.ssid}" (previously saved networks kept as fallback)`,
			actor,
			{ source: 'service', refKind: 'wifi' }
		);
		return json({ seq: r.seq });
	}

	throw error(400, 'Unknown action');
};
