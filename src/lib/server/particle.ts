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
	const res = await fetch(`${PARTICLE_API_BASE}${path}`, {
		...options,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			...options.headers
		}
	});
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
 * Sync all devices from Particle Cloud into the local ParticleDevice collection.
 * Upserts by particleDeviceId to keep local DB in sync.
 */
export async function syncDevices(): Promise<{ synced: number; errors: string[] }> {
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

	return { synced, errors };
}
