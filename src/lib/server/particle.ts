/**
 * Particle.io Cloud API client for IoT device management.
 * Access tokens are stored in the Integration collection (type: 'particle').
 */
import { connectDB, Integration, ParticleDevice, generateId } from '$lib/server/db';

const PARTICLE_API_BASE = 'https://api.particle.io/v1';

interface ParticleApiDevice {
	id: string;
	name: string;
	serial_number?: string;
	platform_id: number;
	firmware_version?: string;
	system_firmware_version?: string;
	status: string;
	last_heard: string | null;
	last_ip_address?: string;
	online: boolean;
}

async function getAccessToken(): Promise<string> {
	await connectDB();
	const integ = await Integration.findOne({ type: 'particle' }).lean() as any;
	if (!integ?.accessToken) {
		throw new Error('Particle integration not configured. Add an access token in Settings.');
	}
	return integ.accessToken;
}

async function particleFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const token = await getAccessToken();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15000);
	const res = await fetch(`${PARTICLE_API_BASE}${path}`, {
		...options,
		signal: controller.signal,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			...options.headers
		}
	}).finally(() => clearTimeout(timeout));
	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: res.statusText }));
		throw new Error(body.error_description || body.error || `Particle API error: ${res.status}`);
	}
	return res;
}

/** List all devices from the Particle Cloud */
export async function listDevices(): Promise<ParticleApiDevice[]> {
	const res = await particleFetch('/devices');
	return res.json();
}

/** Get a single device from the Particle Cloud */
export async function getDevice(deviceId: string): Promise<ParticleApiDevice> {
	const res = await particleFetch(`/devices/${deviceId}`);
	return res.json();
}

/**
 * Last known device vitals (GET /v1/diagnostics/:id/last) — the data behind the
 * console's "Last vitals" panel. Payload shape varies by Device OS version, so
 * every field is extracted defensively and may come back null.
 */
export async function getLastVitals(deviceId: string): Promise<{
	updatedAt: string | null;
	signalStrength: number | null;
	signalQuality: number | null;
	operator: string | null;
	accessTechnology: string | null;
	cellGlobalIdentity: string | null;
	roundTripMs: number | null;
	ramUsed: number | null;
	ramTotal: number | null;
	disconnects: number | null;
	rateLimitedPublishes: number | null;
}> {
	const res = await particleFetch(`/diagnostics/${deviceId}/last`);
	const body = await res.json();
	const d = body?.diagnostics ?? {};
	const p = d.payload?.device ?? {};
	const svc = d.payload?.service ?? {};
	const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
	const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
	return {
		updatedAt: str(d.updated_at),
		signalStrength: num(p.network?.signal?.strength),
		signalQuality: num(p.network?.signal?.quality),
		operator: str(p.network?.cellular?.operator),
		accessTechnology: str(
			p.network?.cellular?.radio_access_technology ?? p.network?.signal?.at
		),
		cellGlobalIdentity: str(p.network?.cellular?.cell_global_identity),
		roundTripMs: num(svc.coap?.round_trip),
		ramUsed: num(p.system?.memory?.used),
		ramTotal: num(p.system?.memory?.total),
		disconnects: num(p.cloud?.connection?.disconnects ?? p.cloud?.disconnects),
		rateLimitedPublishes: num(p.cloud?.publish?.rate_limited)
	};
}

/** Ping a device (PUT /v1/devices/:id/ping) */
export async function pingDevice(deviceId: string): Promise<{ online: boolean; ok: boolean }> {
	const res = await particleFetch(`/devices/${deviceId}/ping`, { method: 'PUT' });
	return res.json();
}

/** Rename a device */
export async function renameDevice(deviceId: string, name: string): Promise<void> {
	await particleFetch(`/devices/${deviceId}`, {
		method: 'PUT',
		body: JSON.stringify({ name })
	});
}

/** Call a function on a device */
export async function callFunction(deviceId: string, functionName: string, arg: string = ''): Promise<{ return_value: number }> {
	const res = await particleFetch(`/devices/${deviceId}/${functionName}`, {
		method: 'POST',
		body: JSON.stringify({ arg })
	});
	return res.json();
}

/** Read a variable from a device */
export async function getVariable(deviceId: string, variableName: string): Promise<any> {
	const res = await particleFetch(`/devices/${deviceId}/${variableName}`);
	return res.json();
}

/** Test connection by listing devices — returns device count on success */
export async function testConnection(accessToken: string): Promise<{ deviceCount: number }> {
	const res = await fetch(`${PARTICLE_API_BASE}/devices`, {
		headers: { Authorization: `Bearer ${accessToken}` }
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: res.statusText }));
		throw new Error(body.error_description || body.error || `HTTP ${res.status}`);
	}
	const devices: ParticleApiDevice[] = await res.json();
	return { deviceCount: devices.length };
}

/**
 * Extract trailing numeric ID from a device name or UDI.
 * e.g. "BT-M01-0000-0209" → "0209", "SPU-0209" → "0209"
 */
function extractNumericId(name: string): string | null {
	const match = name.match(/(\d+)$/);
	return match ? match[1] : null;
}

/**
 * Device names that are eligible for SPU auto-creation during linking.
 *
 * Deliberately strict. The Particle account holds far more than SPUs — cartridge
 * decks (Cartridge_Deck_GEN4_001), tip calibrators, bench tools (TOOL-CT-047) and
 * scratch devices (new4, Argon, owl_narwhal) all carry trailing digits and would
 * otherwise mint junk SPU records into a sacred collection. Only the real SPU
 * naming scheme qualifies; everything else still falls through to `unmatched`.
 */
export const SPU_DEVICE_NAME_PATTERN = /^BT-M01-\d{4}-\d{4}$/;

/**
 * Match Particle devices to SPUs by numeric suffix (e.g. BT-M01-0000-0209 ↔ SPU-0209).
 * Updates SPU.particleLink with the Particle device ID and serial number.
 *
 * A device whose name matches SPU_DEVICE_NAME_PATTERN but has no corresponding SPU
 * gets one created automatically (status 'draft'), so a newly registered device shows
 * up in BIMS without a separate manual registration step.
 */
export async function linkDevicesToSpus(
	actor?: { _id?: string; username?: string }
): Promise<{ linked: number; alreadyLinked: number; created: string[]; unmatched: string[]; errors: string[] }> {
	await connectDB();
	const { Spu, AuditLog } = await import('$lib/server/db');
	const devices = await listDevices();
	const allSpus = await Spu.find({}, { _id: 1, udi: 1, particleLink: 1 }).lean() as any[];
	const errors: string[] = [];
	const unmatched: string[] = [];
	const created: string[] = [];
	const actorLabel = actor?.username ?? actor?._id ?? 'system:particle-sync';
	let linked = 0;
	let alreadyLinked = 0;

	// Lookup maps. `spuByNumber` keeps the original raw-suffix behaviour untouched.
	// `spuByNumberNorm` ignores zero-padding so an existing "SPU-255" still matches a
	// device named "BT-M01-0000-0255" instead of minting a duplicate into a sacred
	// (undeletable) collection — but it is consulted ONLY for SPU-named devices, see below.
	const normaliseNum = (num: string) => String(parseInt(num, 10));
	const spuByNumber = new Map<string, any>();
	const spuByNumberNorm = new Map<string, any>();
	const spuByUdi = new Map<string, any>();
	for (const spu of allSpus) {
		if (spu.udi) spuByUdi.set(spu.udi, spu);
		const num = extractNumericId(spu.udi);
		if (num) {
			spuByNumber.set(num, spu);
			spuByNumberNorm.set(normaliseNum(num), spu);
		}
	}

	for (const device of devices) {
		const deviceName = device.name?.trim();
		if (!deviceName) {
			unmatched.push(`Device ${device.id} (no name)`);
			continue;
		}

		// Extract numeric suffix from Particle device name
		const deviceNum = extractNumericId(deviceName);
		if (!deviceNum) {
			unmatched.push(`${deviceName} (no numeric ID)`);
			continue;
		}

		// Exact UDI wins, then raw suffix (unchanged legacy behaviour). The padding-
		// normalised map is a LAST resort and only for devices whose name is a real SPU
		// name — otherwise "Cartridge_Deck_GEN4_001" (suffix "001" → "1") would match SPU
		// BT-M01-0000-0001 (suffix "0001" → "1") and rename it to the deck's name.
		let spu = spuByUdi.get(deviceName) ?? spuByNumber.get(deviceNum);
		if (!spu && SPU_DEVICE_NAME_PATTERN.test(deviceName)) {
			spu = spuByNumberNorm.get(normaliseNum(deviceNum));
		}

		// No SPU for this device yet — auto-create one if the name is a real SPU name.
		if (!spu) {
			if (!SPU_DEVICE_NAME_PATTERN.test(deviceName)) {
				unmatched.push(`${deviceName} (no SPU with number ${deviceNum})`);
				continue;
			}

			let newSpuId: string;
			try {
				newSpuId = generateId();
				const now = new Date();
				await Spu.create({
					_id: newSpuId,
					udi: deviceName,
					// The device name IS the printed identifier for these units.
					barcode: deviceName,
					status: 'draft',
					assemblyStatus: 'created',
					qcStatus: 'pending',
					statusTransitions: [{
						_id: generateId(),
						from: null,
						to: 'draft',
						changedBy: { _id: actor?._id ?? 'system:particle-sync', username: actorLabel },
						changedAt: now,
						reason: 'auto_created_particle_sync'
					}],
					// Deliberately NOT the acting user: /assembly's "Start new build" reuses a
					// recent draft matching { createdBy: <user>, status:'draft',
					// assemblyStatus:'created' }, which would make an operator assemble a
					// physical unit under a UDI already bound to a Particle device.
					createdBy: 'system:particle-sync'
				});
			} catch (err) {
				errors.push(`${deviceName}: auto-create failed — ${err instanceof Error ? err.message : String(err)}`);
				continue;
			}

			// Registered immediately so a later failure can never orphan an SPU that is
			// absent from created[]/the lookup maps — the row cannot be deleted afterwards.
			spu = { _id: newSpuId, udi: deviceName, particleLink: null };
			spuByNumber.set(deviceNum, spu);
			spuByNumberNorm.set(normaliseNum(deviceNum), spu);
			spuByUdi.set(deviceName, spu);
			created.push(deviceName);

			try {
				await AuditLog.create({
					_id: generateId(),
					tableName: 'spus',
					recordId: newSpuId,
					action: 'INSERT',
					newData: {
						udi: deviceName,
						status: 'draft',
						autoCreatedFrom: 'particle',
						particleDeviceId: device.id
					},
					reason: 'Auto-created from Particle device during link',
					changedBy: actorLabel
				});
			} catch (err) {
				errors.push(`${deviceName}: SPU created but audit log failed — ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// Check if already linked to this device (before the collision guard, so a
		// long-standing link is not re-reported as an error on every single run).
		if (spu.particleLink?.particleDeviceId === device.id) {
			alreadyLinked++;
			continue;
		}

		// Two distinct SPU-named devices share a trailing-digit suffix (e.g.
		// BT-M01-0000-0255 vs BT-M01-0001-0255). Overwriting would silently rename the SPU
		// and steal the other device's link, so refuse and report instead. Non-SPU-named
		// devices are exempt: renaming "SPU-0209" → "BT-M01-0000-0209" is the intended
		// legacy behaviour and must keep working.
		if (spu.udi && spu.udi !== deviceName
			&& SPU_DEVICE_NAME_PATTERN.test(spu.udi) && SPU_DEVICE_NAME_PATTERN.test(deviceName)) {
			errors.push(`${deviceName}: suffix ${deviceNum} already belongs to ${spu.udi} — not relinking`);
			continue;
		}

		try {
			await Spu.updateOne(
				{ _id: spu._id },
				{
					$set: {
						udi: deviceName,
						'particleLink.particleDeviceId': device.id,
						'particleLink.particleSerial': device.serial_number ?? null,
						'particleLink.linkedAt': new Date()
					}
				}
			);
			linked++;
		} catch (err) {
			errors.push(`${deviceName}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return { linked, alreadyLinked, created, unmatched, errors };
}

/**
 * Sync all devices from Particle Cloud into the local ParticleDevice collection.
 * Upserts by particleDeviceId to keep local DB in sync.
 */
export async function syncDevices(
	actor?: { _id?: string; username?: string }
): Promise<{ synced: number; created: string[]; errors: string[] }> {
	await connectDB();
	const devices = await listDevices();
	const errors: string[] = [];
	let synced = 0;

	for (const d of devices) {
		try {
			const existing = await ParticleDevice.findOne({ particleDeviceId: d.id }).lean() as any;
			const update = {
				particleDeviceId: d.id,
				name: d.name,
				serialNumber: d.serial_number ?? null,
				platformId: d.platform_id,
				firmwareVersion: d.firmware_version ?? null,
				systemVersion: d.system_firmware_version ?? null,
				status: d.online ? 'online' : 'offline',
				lastHeardAt: d.last_heard ? new Date(d.last_heard) : null,
				lastIpAddress: d.last_ip_address ?? null
			};

			if (existing) {
				await ParticleDevice.updateOne({ _id: existing._id }, { $set: update });
			} else {
				await ParticleDevice.create({ _id: generateId(), ...update });
			}
			synced++;
		} catch (err) {
			errors.push(`Device ${d.id}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Update integration sync status
	await Integration.updateOne(
		{ type: 'particle' },
		{
			$set: {
				lastSyncAt: new Date(),
				lastSyncStatus: errors.length ? 'error' : 'success',
				lastSyncError: errors.length ? errors.join('; ') : null
			}
		}
	);

	// Auto-link devices to SPUs after sync (also auto-creates SPUs for new devices).
	// Linking is non-fatal to the sync itself, but its errors must NOT be swallowed —
	// this path writes to a sacred collection, so a silent failure is unacceptable.
	let created: string[] = [];
	try {
		const linkResult = await linkDevicesToSpus(actor);
		created = linkResult.created;
		errors.push(...linkResult.errors);
	} catch (err) {
		errors.push(`Linking failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	return { synced, created, errors };
}
