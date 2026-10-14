/**
 * Particle Cloud Webhook Handler
 *
 * Receives events from Particle Cloud webhooks and stores them as DeviceEvent records.
 * Particle webhooks send JSON POST payloads with event data.
 *
 * Configure in Particle Console (docs/particle-webhooks-screen.md has every event):
 *   URL: https://<your-domain>/api/particle/webhook
 *   Request Type: POST
 *   Request Format: JSON
 *   Header: x-agent-api-key: <AGENT_API_KEY>
 *
 * Events handled beyond the generic DeviceEvent log:
 *   blank-test               v96  binary test record of a BLANK- run → optical_blank_runs
 *   bioscale/screen          v102 SCREEN level/summary JSON → validation_sessions 'screen'
 *   bioscale/ping            v102 cloud round-trip probe → 200 {ok,nonce,at}, nothing stored
 *   bioscale/screen_record   v102 chunked base64 test record of a SCREEN assay run
 *   bioscale/mag_sweep_chunk v98  chunked sweep rows → validation_sessions 'mag_sweep'
 *   bioscale/sweep_progress  v102 {"id","i","of"} while a sweep runs
 */
import { json } from '@sveltejs/kit';
import { connectDB, DeviceEvent, ParticleDevice, Spu, OpticalBlankRun, generateId } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { syncServiceFlag, syncMonitorFlag } from '$lib/server/service-flag';
import { parseTestPayload, parseTestRecordBuffer } from '$lib/server/test-payload';
import { ingestScreenEvent, attachScreenRecord } from '$lib/server/screen/ingest';
import { ingestSweepText } from '$lib/server/sweep/ingest';
import { parseChunkEnvelope, storeChunk, assembleChunks, markJob, recordProgress } from '$lib/server/chunks';
import type { RequestHandler } from './$types';

/** Strip an optional "bioscale/" prefix so both spellings route the same. */
function bare(eventName: string): string {
	return eventName.startsWith('bioscale/') ? eventName.slice('bioscale/'.length) : eventName;
}

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();

	// Particle webhook payload format:
	// { event: "event_name", data: "...", coreid: "device_id", published_at: "ISO string" }
	const {
		event: eventName,
		data: eventData,
		coreid: deviceId,
		published_at: publishedAt
	} = body;

	if (!deviceId) {
		return json({ error: 'Missing coreid (device ID)' }, { status: 400 });
	}
	const at = publishedAt ? new Date(publishedAt) : new Date();
	const kind = bare(String(eventName ?? ''));

	// ---- ping: answer fast, store nothing. The device times the hook-response. ----
	if (kind === 'ping') {
		let nonce: unknown = null;
		try {
			nonce = typeof eventData === 'string' ? JSON.parse(eventData)?.nonce : (eventData as any)?.nonce;
		} catch {
			nonce = null;
		}
		await ParticleDevice.updateOne({ particleDeviceId: deviceId }, { $set: { lastHeardAt: at, status: 'online' } });
		return json({ ok: true, nonce: nonce ?? null, at: new Date().toISOString() });
	}

	// ---- sweep progress: tiny, frequent, not an event worth logging ----
	if (kind === 'sweep_progress') {
		try {
			const p = typeof eventData === 'string' ? JSON.parse(eventData) : eventData;
			if (p?.id != null) await recordProgress(deviceId, 'mag_sweep', String(p.id), Number(p.i) || 0, Number(p.of) || 0);
		} catch {
			/* malformed progress is not worth a 400 — the chunks tell the real story */
		}
		return json({ success: true, event: kind, deviceId });
	}

	// ---- chunked uploads: sweep rows and screen records ----
	if (kind === 'mag_sweep_chunk' || kind === 'screen_record') {
		const env = parseChunkEnvelope(eventData);
		if (!env) return json({ error: `${kind}: not a chunk envelope` }, { status: 400 });
		const chunkKind = kind === 'mag_sweep_chunk' ? 'mag_sweep' : 'screen_record';
		const stored = await storeChunk(deviceId, chunkKind, env, publishedAt ? at : null);
		let assembled: string | null = null;
		if (stored.complete) {
			const text = await assembleChunks(deviceId, chunkKind, env.id);
			if (text != null) {
				try {
					if (chunkKind === 'mag_sweep') {
						const r = await ingestSweepText(deviceId, env.id, text, at);
						if ('error' in r) {
							await markJob(deviceId, chunkKind, env.id, { status: 'failed', lastError: r.error });
						} else {
							await markJob(deviceId, chunkKind, env.id, { status: 'assembled', assembledAt: new Date(), sessionId: r.sessionId, lastError: null });
							assembled = r.sessionId;
						}
					} else {
						// id = run*10 + runIndex (the firmware prints its unsigned-long id);
						// payload = base64 in 76-char newline-terminated lines.
						const idNum = Number(env.id);
						const run = Math.floor(idNum / 10);
						const runIndex = idNum % 10;
						const b64 = text.replace(/[\r\n\s]/g, '');
						const buf = Buffer.from(b64, 'base64');
						const payload = parseTestRecordBuffer(buf);
						if (!payload) {
							await markJob(deviceId, chunkKind, env.id, { status: 'failed', lastError: `assembled ${buf.length} bytes do not parse as a test record` });
						} else {
							const r = await attachScreenRecord(deviceId, run, runIndex, payload, at);
							await markJob(deviceId, chunkKind, env.id, { status: 'assembled', assembledAt: new Date(), sessionId: r.sessionId, lastError: null });
							assembled = r.sessionId;
						}
					}
				} catch (err) {
					await markJob(deviceId, chunkKind, env.id, { status: 'failed', lastError: err instanceof Error ? err.message : String(err) });
				}
			}
		}
		await ParticleDevice.updateOne({ particleDeviceId: deviceId }, { $set: { lastHeardAt: at, status: 'online' } });
		// Only the LAST chunk of a run gets a DeviceEvent line, so a 109-chunk sweep
		// is one row in the device log, not a hundred.
		if (env.seq === env.total - 1 || stored.complete) {
			await DeviceEvent.create({
				_id: generateId(),
				deviceId,
				eventType: kind,
				eventData: { id: env.id, received: stored.received, total: stored.total, missing: stored.missing.slice(0, 20), sessionId: assembled },
				cartridgeUuid: null,
				success: stored.complete,
				errorMessage: stored.complete ? null : `${stored.missing.length} chunk(s) missing`,
				createdAt: at
			});
		}
		return json({ success: true, event: kind, deviceId, id: env.id, received: stored.received, total: stored.total, missing: stored.missing, sessionId: assembled });
	}

	// ---- SCREEN level / summary events ----
	if (kind === 'screen') {
		const r = await ingestScreenEvent(deviceId, eventData, publishedAt ? at : null);
		if ('error' in r) return json({ error: r.error }, { status: 400 });
		await DeviceEvent.create({
			_id: generateId(),
			deviceId,
			eventType: 'screen',
			eventData: { sessionId: r.sessionId, spuUdi: r.spuUdi, complete: r.complete, overallPassed: r.overallPassed, raw: typeof eventData === 'string' ? eventData.slice(0, 400) : eventData },
			cartridgeUuid: null,
			success: r.overallPassed !== false,
			errorMessage: null,
			createdAt: at
		});
		await ParticleDevice.updateOne({ particleDeviceId: deviceId }, { $set: { lastHeardAt: at, status: 'online' } });
		return json({ success: true, event: 'screen', deviceId, ...r });
	}

	// Map Particle event names to our event types
	const eventTypeMap: Record<string, string> = {
		'bioscale/validate': 'validate',
		'bioscale/load_assay': 'load_assay',
		'bioscale/upload': 'upload',
		'bioscale/reset': 'reset',
		'bioscale/error': 'error',
		validate: 'validate',
		load_assay: 'load_assay',
		upload: 'upload',
		reset: 'reset',
		error: 'error'
	};

	const eventType = eventTypeMap[eventName] ?? eventName;

	// Parse event data (may be JSON string or plain string)
	let parsedData: any = eventData;
	if (typeof eventData === 'string') {
		try {
			parsedData = JSON.parse(eventData);
		} catch {
			parsedData = { raw: eventData };
		}
	}

	// Blank-cartridge run (firmware v96): the device publishes its binary test
	// record under `blank-test` instead of `upload-test`, so it never reaches
	// the cloud middleware or a cartridge record. Store it as an optical blank
	// run against the unit; the DeviceEvent keeps only a summary (not the blob).
	let blankRunId: string | null = null;
	if ((eventName === 'blank-test' || eventName === 'bioscale/blank-test') && typeof eventData === 'string') {
		const payload = parseTestPayload(eventData);
		if (!payload) {
			return json({ error: 'blank-test payload is not a test record' }, { status: 400 });
		}
		const spu = (await Spu.findOne({ 'particleLink.particleDeviceId': deviceId })
			.select('_id udi')
			.lean()) as any;
		blankRunId = generateId();
		await OpticalBlankRun.create({
			_id: blankRunId,
			deviceId,
			spuId: spu?._id ?? null,
			spuUdi: spu?.udi ?? null,
			barcode: payload.cartridgeId || null,
			assayId: payload.assayId || null,
			startTime: payload.startTime ? new Date(payload.startTime * 1000) : null,
			durationS: payload.duration,
			numberOfReadings: payload.numberOfReadings,
			checksum: payload.checksum,
			readings: payload.readings,
			// v101+ stage travel check (TASK-201): rides in the record tail.
			stageCheck: payload.stageCheck,
			publishedAt: publishedAt ? new Date(publishedAt) : null
		});
		parsedData = {
			blankRun: blankRunId,
			cartridgeUuid: payload.cartridgeId,
			assayId: payload.assayId,
			numberOfReadings: payload.numberOfReadings,
			stageCheck: payload.stageCheck,
			spuUdi: spu?.udi ?? null
		};
	}

	// Create immutable device event
	await DeviceEvent.create({
		_id: generateId(),
		deviceId,
		eventType,
		eventData: parsedData,
		cartridgeUuid: parsedData?.cartridgeUuid ?? parsedData?.cartridge_uuid ?? null,
		success: parsedData?.success !== false && eventType !== 'error',
		errorMessage: parsedData?.error ?? parsedData?.errorMessage ?? null,
		createdAt: publishedAt ? new Date(publishedAt) : new Date()
	});

	// Update device last-heard timestamp
	await ParticleDevice.updateOne(
		{ particleDeviceId: deviceId },
		{
			$set: {
				lastHeardAt: publishedAt ? new Date(publishedAt) : new Date(),
				status: 'online'
			}
		}
	);

	// Device came (back) online → re-push the service-flag LED bit so a status
	// change made while it was unplugged takes effect now (SPU-INV-08).
	// Requires a Particle Console webhook on event `spark/status` with the
	// agent API key header.
	if (eventName === 'spark/status' && String(eventData).trim() === 'online') {
		const spu = (await Spu.findOne({ 'particleLink.particleDeviceId': deviceId })
			.select('_id')
			.lean()) as any;
		if (spu) {
			await syncServiceFlag(spu._id);
			await syncMonitorFlag(spu._id); // v103 monitor mode; no-op below firmware 103
		}
	}

	return json({ success: true, event: eventType, deviceId, ...(blankRunId ? { blankRunId } : {}) });
};
