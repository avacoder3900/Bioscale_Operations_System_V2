import { json, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, Spu } from '$lib/server/db';
import { getDevice } from '$lib/server/particle';
import type { RequestHandler } from './$types';

/**
 * Progress poll for a queued magnetometer sweep.
 *
 * A sweep blocks the device's main loop for ~19 minutes. During that window the
 * device stops servicing the cloud entirely and drops offline, so THE OFFLINE
 * STATE IS THE EXPECTED STATE WHILE IT RUNS — reporting it as a failure would
 * flag every successful sweep as broken. The only positive completion signal is
 * a new `type: 'mag_sweep'` ValidationSession appearing for the SPU.
 *
 * `since` is the moment the operator queued the run. Anything older than that is
 * a previous sweep and must not be mistaken for this one finishing.
 */

/** DeviceMode::IDLE — ordinals are stable, see DeviceState.h. */
const DEVICE_MODE_IDLE = 0;

/** Past this, a sweep that has produced nothing has almost certainly died rather
 *  than still being slow. The full run is ~19 min; the device also has to come
 *  back and upload ~109 chunks at roughly one per second. */
const STALE_AFTER_MS = 45 * 60 * 1000;

export const GET: RequestHandler = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spuId = url.searchParams.get('spuId');
	if (!spuId) throw error(400, 'spuId is required');

	// Whether the CALLER has observed the device drop offline during this run.
	// The endpoint is stateless and each poll is a fresh snapshot, so it cannot
	// see the offline window itself — but the page polling every ~18s can, and
	// that transition is the only positive proof a sweep is genuinely running.
	// Absent (null) means the caller did not say; only an explicit 'false' is
	// treated as "definitely never went offline".
	const sawOfflineRaw = url.searchParams.get('sawOffline');
	const sawOffline = sawOfflineRaw === null ? null : sawOfflineRaw === 'true';

	const sinceRaw = url.searchParams.get('since');
	const since = sinceRaw ? new Date(sinceRaw) : null;
	if (since && Number.isNaN(since.getTime())) throw error(400, 'since is not a valid date');

	const spu = (await Spu.findById(spuId, { udi: 1, 'particleLink.particleDeviceId': 1 }).lean()) as any;
	if (!spu) throw error(404, 'SPU not found');

	// Completion first: a landed session is authoritative regardless of what the
	// device currently reports, and it is cheap.
	const filter: Record<string, unknown> = { type: 'mag_sweep', spuId };
	if (since) filter.createdAt = { $gt: since };

	const landed = (await ValidationSession.findOne(filter, {
		spuId: 1,
		spuUdi: 1,
		createdAt: 1,
		startedAt: 1,
		completedAt: 1,
		'magResults.wellNumbers': 1,
		'magResults.rowsIngested': 1
	})
		.sort({ createdAt: -1 })
		.lean()) as any;

	if (landed) {
		return json({
			status: 'complete',
			sessionId: landed._id,
			completedAt: landed.completedAt ?? landed.createdAt ?? null,
			wells: landed.magResults?.wellNumbers ?? [],
			rows: landed.magResults?.rowsIngested ?? null
		});
	}

	const elapsedMs = since ? Date.now() - since.getTime() : null;
	const stale = elapsedMs !== null && elapsedMs > STALE_AFTER_MS;

	const deviceId = spu.particleLink?.particleDeviceId ?? null;
	if (!deviceId) {
		return json({ status: stale ? 'stale' : 'unknown', elapsedMs, reason: 'SPU has no Particle device linked' });
	}

	// The device is unreachable for most of the run, so a failed lookup is not an
	// error condition here — it is indistinguishable from a sweep in progress.
	let connected: boolean | null = null;
	let mode: number | null = null;
	try {
		const info = await getDevice(deviceId);
		connected = info.connected ?? info.online ?? null;
	} catch {
		connected = null;
	}

	if (connected === false || connected === null) {
		return json({
			status: stale ? 'stale' : 'running',
			elapsedMs,
			deviceOnline: false,
			// Said explicitly because the obvious reading of "offline" is "broken".
			note: 'Device is offline, which is expected while a sweep runs — it stops servicing the cloud for the whole run.'
		});
	}

	// Back online with nothing stored yet: either uploading its ~109 chunks, or it
	// returned to idle without producing anything (a sweep that never started).
	try {
		const { callFunction } = await import('$lib/server/particle');
		const res = await callFunction(deviceId, 'get_state', '');
		mode = typeof res?.return_value === 'number' ? res.return_value : null;
	} catch {
		mode = null;
	}

	if (mode === DEVICE_MODE_IDLE) {
		// A sweep BLOCKS the device's main loop, so a real one always drags the
		// device offline for its whole duration. If the caller has been polling
		// throughout and never once saw it drop, the sweep did not run — it was
		// rejected on the device after run_sweep had already returned 1 (no
		// magnetometer connected is the usual cause).
		//
		// Reporting that as "uploading" is what this endpoint used to do, and it is
		// actively harmful: it told an operator to keep waiting for 22 minutes on a
		// run that had died within seconds. Absence of the offline transition is
		// positive evidence of failure, not of progress.
		if (sawOffline === false) {
			return json({
				status: 'not_running',
				elapsedMs,
				deviceOnline: true,
				deviceMode: mode,
				note: 'The device never went offline, so no sweep is running — a sweep blocks the device for its entire duration. It was almost certainly refused on the device: check that the magnetometer jig is inserted AND that the regular validation has run, which is what establishes the BLE link.'
			});
		}

		return json({
			status: stale ? 'stale' : 'uploading',
			elapsedMs,
			deviceOnline: true,
			deviceMode: mode,
			note: 'Device is back online and idle but no sweep has been stored yet — most likely still uploading its chunks.'
		});
	}

	return json({ status: stale ? 'stale' : 'running', elapsedMs, deviceOnline: true, deviceMode: mode });
};
