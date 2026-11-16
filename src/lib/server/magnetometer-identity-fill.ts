/**
 * Magnetometer identity — the database half.
 *
 * Fallback for readings whose sender did not say which magnetometer took them:
 * the SPU scans the magnetometer's barcode before the five-point test and
 * prints it in its own log. Those lines reach Mongo only inside uploaded device
 * logs (`device_logs`, and `device_events` of type `device-log`), and logs are
 * uploaded rarely — often days after the reading — so the fill runs both when a
 * reading is stored and when a log arrives.
 *
 * Everything here is best-effort and must never fail the ingest that called
 * it: every public function swallows its own errors.
 */
import { connectDB, AuditLog, DeviceEvent, DeviceLog, Spu, ValidationSession, generateId } from '$lib/server/db';
import { extractMagTestTime } from '$lib/server/magnetometer-time';
import {
	buildMagnetometerRecord,
	chooseScan,
	decodeDeviceLogEvent,
	extractMagnetometerScans,
	extractMagnetometerFromMagPayload,
	normaliseMagnetometerBarcode,
	pickMagnetometer,
	SCAN_WINDOWS,
	type MagnetometerScan
} from '$lib/server/magnetometer-identity';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A log can be uploaded long after the scan it records. */
const LOG_LOOKAHEAD_MS = 60 * DAY_MS;
const SYSTEM_ACTOR = 'system:device-log';

const SESSION_FIELDS = {
	type: 1, spuId: 1, particleDeviceId: 1, testRanAt: 1, createdAt: 1, startedAt: 1, magnetometer: 1
} as const;

/** An identity someone or something asserted directly is never replaced by a log match. */
function fillable(session: any): boolean {
	const cur = session?.magnetometer;
	return !cur?.barcode || cur.source === 'inferred';
}

/**
 * When the reading was taken, as far as it can be trusted.
 *
 * mag: ONLY the device's own epoch. The time BIMS recorded a five-point test is
 * the time it polled a variable that may be months stale, so without testRanAt
 * there is nothing to match a scan against.
 * mag_sweep: the device epoch when the upload carried one, otherwise when BIMS
 * stored it (the bench pusher posts as the sweep ends).
 */
async function readingTime(session: any): Promise<Date | null> {
	if (session.testRanAt) return new Date(session.testRanAt);
	if (session.type === 'mag') {
		const raw = (await ValidationSession.findById(session._id).select('rawData').lean()) as any;
		return extractMagTestTime(raw?.rawData)?.at ?? null;
	}
	const t = session.createdAt ?? session.startedAt ?? null;
	return t ? new Date(t) : null;
}

async function deviceIdFor(session: any): Promise<string | null> {
	if (session.particleDeviceId) return String(session.particleDeviceId);
	if (!session.spuId) return null;
	const spu = (await Spu.findById(session.spuId).select('particleLink.particleDeviceId').lean()) as any;
	return spu?.particleLink?.particleDeviceId ?? null;
}

/** Every timed-or-untimed magnetometer scan a device logged, from uploads in [from, to]. */
export async function loadDeviceScans(deviceId: string, from: Date, to: Date): Promise<MagnetometerScan[]> {
	const scans: MagnetometerScan[] = [];

	const logs = (await DeviceLog.find({
		deviceId,
		uploadedAt: { $gte: from, $lte: to },
		'logLines.message': /MAG-\d{3}/i
	})
		.select('uploadedAt logLines')
		.sort({ uploadedAt: 1 })
		.limit(60)
		.lean()) as any[];
	for (const log of logs) scans.push(...extractMagnetometerScans(log.logLines, new Date(log.uploadedAt)));

	// The same uploads also land as raw device events (30-day TTL). A string
	// payload is base64, so it cannot be pre-filtered on the barcode text.
	const events = (await DeviceEvent.find({
		deviceId,
		eventType: 'device-log',
		createdAt: { $gte: from, $lte: to }
	})
		.select('createdAt eventData')
		.sort({ createdAt: 1 })
		.limit(300)
		.lean()) as any[];
	for (const ev of events) {
		scans.push(...extractMagnetometerScans(decodeDeviceLogEvent(ev.eventData), new Date(ev.createdAt)));
	}

	return scans;
}

const UNSET_OR_INFERRED = [
	{ magnetometer: null },
	{ 'magnetometer.barcode': { $in: [null, ''] } },
	{ 'magnetometer.source': 'inferred' }
];

/**
 * The identity the device sent with the reading, read back out of the stored
 * rawData: `rawData.meta.mag` on a sweep, the trailing `mag=` line of a
 * five-point payload. Writes source 'device'. Null when the reading carries none.
 */
async function promoteFromRawData(session: any): Promise<FillResult | null> {
	const raw = (await ValidationSession.findById(session._id)
		.select(session.type === 'mag' ? 'rawData' : 'rawData.meta')
		.lean()) as any;
	const id =
		session.type === 'mag'
			? extractMagnetometerFromMagPayload(raw?.rawData)
			: pickMagnetometer(null, raw?.rawData?.meta);
	if (!id) return null;

	const record = buildMagnetometerRecord(id, 'device', 'system:raw-data');
	const previous = session.magnetometer?.barcode ? session.magnetometer : null;
	const res = await ValidationSession.updateOne({ _id: session._id, $or: UNSET_OR_INFERRED }, { $set: { magnetometer: record } });
	if (!res.modifiedCount) return { filled: false, reason: 'already recorded' };

	await AuditLog.create({
		_id: generateId(),
		tableName: 'validation_sessions',
		recordId: session._id,
		action: 'UPDATE',
		oldData: { magnetometer: previous },
		newData: { magnetometer: record },
		changedAt: new Date(),
		changedBy: 'system:raw-data',
		reason: `Magnetometer ${id.label} taken from the mag= value the device sent with the reading`
	});
	return { filled: true, barcode: id.barcode, label: id.label, source: 'device', scannedAt: null };
}

export type FillResult =
	| { filled: true; barcode: string; label: string; source: 'device' | 'device-log'; scannedAt: Date | null }
	| { filled: false; reason: string };

/**
 * Fill one session's magnetometer from the device's uploaded logs.
 * Leaves the field alone when there is no scan inside the window, when the
 * reading has no trustworthy time, or when an identity is already recorded.
 */
export async function fillMagnetometerFromDeviceLogs(
	sessionOrId: string | Record<string, any>,
	opts: { scans?: MagnetometerScan[] } = {}
): Promise<FillResult> {
	try {
		await connectDB();
		const session =
			typeof sessionOrId === 'string'
				? ((await ValidationSession.findById(sessionOrId).select(SESSION_FIELDS).lean()) as any)
				: sessionOrId;
		if (!session) return { filled: false, reason: 'session not found' };
		if (session.type !== 'mag' && session.type !== 'mag_sweep') return { filled: false, reason: 'not a magnetometer session' };
		if (!fillable(session)) return { filled: false, reason: 'already recorded' };

		// What the device itself wrote wins over anything read from a log. Firmware
		// v110 puts `mag=` in the sweep header and after the well rows of the
		// five-point file, and the ingest code that ran BEFORE this field existed
		// already kept both verbatim (rawData.meta.mag / the raw payload string) —
		// so a session stored by the older code is promoted here.
		const promoted = await promoteFromRawData(session);
		if (promoted) return promoted;

		const at = await readingTime(session);
		if (!at) return { filled: false, reason: 'reading has no trustworthy time' };

		const window = SCAN_WINDOWS[session.type as 'mag' | 'mag_sweep'];
		let scans = opts.scans;
		if (!scans) {
			const deviceId = await deviceIdFor(session);
			if (!deviceId) return { filled: false, reason: 'no device id' };
			scans = await loadDeviceScans(
				deviceId,
				new Date(at.getTime() - window.afterMs - 60 * 60 * 1000),
				new Date(at.getTime() + LOG_LOOKAHEAD_MS)
			);
		}

		const scan = chooseScan(scans, at, window);
		if (!scan || !scan.at) return { filled: false, reason: 'no scan inside the window' };

		const record = buildMagnetometerRecord(scan, 'device-log', SYSTEM_ACTOR, { scannedAt: scan.at });
		const previous = session.magnetometer?.barcode ? session.magnetometer : null;

		// Guarded on the same condition that was checked above, so a manual entry
		// made in the meantime wins.
		const res = await ValidationSession.updateOne(
			{
				_id: session._id,
				$or: [
					{ magnetometer: null },
					{ 'magnetometer.barcode': { $in: [null, ''] } },
					{ 'magnetometer.source': 'inferred' }
				]
			},
			{ $set: { magnetometer: record } }
		);
		if (!res.modifiedCount) return { filled: false, reason: 'already recorded' };

		await AuditLog.create({
			_id: generateId(),
			tableName: 'validation_sessions',
			recordId: session._id,
			action: 'UPDATE',
			oldData: { magnetometer: previous },
			newData: { magnetometer: record, scanTiming: scan.timing },
			changedAt: new Date(),
			changedBy: SYSTEM_ACTOR,
			reason: `Magnetometer ${scan.label} matched from the device log (barcode scan at ${scan.at.toISOString()})`
		});

		return { filled: true, barcode: scan.barcode, label: scan.label, source: 'device-log', scannedAt: scan.at };
	} catch (e) {
		console.warn('[magnetometer-identity] device-log fill failed:', (e as Error).message);
		return { filled: false, reason: (e as Error).message };
	}
}

/**
 * Retry the device-log fill for recent magnetometer sessions that still have no
 * (or only an inferred) identity. Called when a device log arrives — the log
 * that explains a sweep usually lands after the sweep — and after a sweep is
 * stored, to pick up logs that were written to Mongo by something other than
 * BIMS in the meantime.
 *
 * `deviceId` narrows it to one device; without it every device with an open
 * session in the look-back is tried.
 */
export async function reconcileMagnetometers(
	opts: { deviceId?: string | null; days?: number; limit?: number; types?: ('mag' | 'mag_sweep')[] } = {}
): Promise<{ checked: number; filled: number }> {
	const out = { checked: 0, filled: 0 };
	try {
		await connectDB();
		const since = new Date(Date.now() - (opts.days ?? 60) * DAY_MS);

		const filter: Record<string, unknown> = {
			type: { $in: opts.types ?? ['mag', 'mag_sweep'] },
			startedAt: { $gte: since },
			$or: [
				{ magnetometer: null },
				{ 'magnetometer.barcode': { $in: [null, ''] } },
				{ 'magnetometer.source': 'inferred' }
			]
		};

		if (opts.deviceId) {
			const spus = (await Spu.find({ 'particleLink.particleDeviceId': opts.deviceId }).select('_id').lean()) as any[];
			filter.$and = [{ $or: [{ particleDeviceId: opts.deviceId }, { spuId: { $in: spus.map((s) => s._id) } }] }];
		}

		const sessions = (await ValidationSession.find(filter)
			.select(SESSION_FIELDS)
			.sort({ startedAt: -1 })
			.limit(opts.limit ?? 200)
			.lean()) as any[];
		if (sessions.length === 0) return out;

		// One log read per device, shared by all of that device's sessions.
		const scansByDevice = new Map<string, MagnetometerScan[]>();
		for (const s of sessions) {
			const deviceId = opts.deviceId ?? (await deviceIdFor(s));
			if (!deviceId) continue;
			let scans = scansByDevice.get(deviceId);
			if (!scans) {
				scans = await loadDeviceScans(deviceId, new Date(since.getTime() - DAY_MS), new Date());
				scansByDevice.set(deviceId, scans);
			}
			out.checked++;
			// Not skipped when the device has no scans: the reading's own rawData may
			// still carry a mag= value.
			const r = await fillMagnetometerFromDeviceLogs(s, { scans });
			if (r.filled) out.filled++;
		}
	} catch (e) {
		console.warn('[magnetometer-identity] reconcile failed:', (e as Error).message);
	}
	return out;
}

export type ManualSetResult =
	| { ok: true; magnetometer: { barcode: string; label: string; source: string } | null }
	| { ok: false; status: number; error: string };

/**
 * A person sets, corrects or clears the magnetometer on a session. Shared by
 * the sweep page and the mag session page so both write the same record and
 * the same audit entry. An empty barcode clears the field (for undoing a wrong
 * match); anything else must be a well-formed MAG-ddd[-hex] barcode.
 *
 * validation_sessions is not under the sacred or immutable middleware, and the
 * identity is provenance about the reading rather than part of its result, so
 * this is a plain audited update — no finalisation gate, no override record.
 */
export async function setMagnetometerManually(
	sessionId: string,
	rawBarcode: string,
	user: { _id: string; username: string },
	types: string[] = ['mag', 'mag_sweep']
): Promise<ManualSetResult> {
	await connectDB();
	const session = (await ValidationSession.findOne({ _id: sessionId, type: { $in: types } })
		.select({ magnetometer: 1, spuId: 1 })
		.lean()) as any;
	if (!session) return { ok: false, status: 404, error: 'Session not found' };

	const trimmed = rawBarcode.trim();
	const id = trimmed ? normaliseMagnetometerBarcode(trimmed) : null;
	if (trimmed && !id) {
		return { ok: false, status: 400, error: 'Not a magnetometer barcode. Expected MAG-001 or MAG-001-<hex>.' };
	}

	const previous = session.magnetometer?.barcode ? session.magnetometer : null;
	if (!id && !previous) return { ok: true, magnetometer: null };

	const record = id ? buildMagnetometerRecord(id, 'manual', user._id) : null;
	await ValidationSession.updateOne({ _id: sessionId }, { $set: { magnetometer: record } });

	await AuditLog.create({
		_id: generateId(),
		tableName: 'validation_sessions',
		recordId: sessionId,
		entityId: session.spuId ?? sessionId,
		action: 'UPDATE',
		oldData: { magnetometer: previous },
		newData: { magnetometer: record, setBy: user.username },
		changedAt: new Date(),
		changedBy: user._id,
		reason: record
			? `Magnetometer set to ${record.barcode}${previous ? ` (was ${previous.barcode}, ${previous.source})` : ''}`
			: `Magnetometer cleared (was ${previous.barcode}, ${previous.source})`
	});

	return { ok: true, magnetometer: record ? { barcode: record.barcode, label: record.label, source: record.source } : null };
}
