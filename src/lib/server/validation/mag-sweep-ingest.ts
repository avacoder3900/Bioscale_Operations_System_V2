/**
 * Magnetometer sweep chunk ingest.
 *
 * A sweep is far too large for a single Particle publish (~1 KB cap), so firmware
 * v98 ships it as a sequence of chunk events. This module owns the whole
 * receiving side: recognising a chunk event, buffering it, assembling the sweep
 * once every chunk has landed, and writing the ValidationSession.
 *
 * It lives here rather than inline in the webhook route deliberately. That route
 * is under active development for unrelated things (optical blank runs, the
 * service-flag re-push on spark/status) and inlining ~250 lines of sweep logic
 * into it would make every future merge a conflict.
 *
 * A SWEEP IS NOT A PASS/FAIL GATE: nothing here writes qcStatus or
 * Spu.validation.magnetometer.*, and overallPassed is left undefined.
 */
import { json } from '@sveltejs/kit';
import {
	connectDB,
	AuditLog,
	DeviceEvent,
	ParticleDevice,
	Spu,
	SweepUpload,
	ValidationSession,
	generateId
} from '$lib/server/db';
import { summarise } from '$lib/server/validation/mag-sweep';
import {
	assembleChunks,
	decodeSweepPayload,
	parseChunkEnvelope,
	MAX_ASSEMBLED_BYTES,
	type ChunkEnvelope
} from '$lib/server/validation/mag-sweep-chunks';
/** How long a partially delivered sweep is kept before Mongo reaps it. */
const SWEEP_BUFFER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Sweep-chunk event names, matched loosely on purpose: the firmware half is
 * being written in parallel, and losing a ten-minute sweep because the device
 * said "mag-sweep-chunk" and we only knew "mag_sweep_chunk" is not a tradeoff
 * worth making.
 */
const SWEEP_CHUNK_NAMES = new Set([
	// What firmware v98 actually publishes (MAGNETOMETER_SWEEP_EVENT_NAME).
	'mag_sweep_chunk',
	'magsweep_chunk', 'sweep_chunk', 'mag_sweep', 'magsweep', 'magnet_sweep', 'magnet_sweep_chunk'
]);

export function isSweepChunkEvent(eventName: unknown): boolean {
	if (typeof eventName !== 'string') return false;
	const bare = eventName.toLowerCase().replace(/^bioscale\//, '').replace(/[-\s]/g, '_');
	return SWEEP_CHUNK_NAMES.has(bare);
}

/**
 * Find the SPU a sweep belongs to. An identifier the device put in its own
 * header wins; otherwise the SPU currently linked to that Particle device.
 * Returns null rather than throwing — a sweep that cannot be filed is a
 * recoverable state (link the device, resend), not a bad request.
 */
async function resolveSweepSpu(spuToken: string | null, deviceId: string) {
	if (spuToken) {
		const exact = await Spu.findOne({
			$or: [{ _id: spuToken }, { udi: spuToken }, { barcode: spuToken }]
		}).lean() as any;
		if (exact) return exact;

		const escaped = spuToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const matches = await Spu.find({ udi: { $regex: `${escaped}$` } }, { udi: 1 }).limit(5).lean() as any[];
		// An ambiguous suffix is not resolved by guessing; fall through to the
		// device link, which is unambiguous.
		if (matches.length === 1) return await Spu.findById(matches[0]._id).lean() as any;
	}

	return await Spu.findOne({ 'particleLink.particleDeviceId': deviceId }).lean() as any;
}

// Both arms carry every key (absent ones typed `undefined`) so a reader can
// pull `.error` or `.sessionId` off the union without first narrowing it.
type AssembleResult =
	| {
			assembled: true;
			sessionId: string;
			spuId: string;
			spuUdi: string;
			rowsIngested: number;
			wells: number[];
			warning?: string;
			error?: undefined;
			missing?: undefined;
	  }
	| {
			assembled: false;
			sessionId?: undefined;
			warning?: undefined;
			error?: string;
			missing?: number[];
	  };

/**
 * Assemble a complete buffer into a ValidationSession.
 *
 * Only ever called by the invocation that won the atomic 'receiving' ->
 * 'assembling' claim, so concurrent delivery of the last two chunks cannot
 * produce two sessions for one sweep.
 */
async function assembleSweep(buffer: any): Promise<AssembleResult> {
	const { text, missing } = assembleChunks(buffer.chunks, buffer.totalChunks);

	if (!text) {
		// Lost the race with a count that included an out-of-range key, or a
		// chunk vanished between the count and the claim. Not fatal: go back to
		// receiving so a resend still completes the sweep.
		const message = `missing chunks: ${missing.slice(0, 20).join(', ')}`;
		await SweepUpload.updateOne({ _id: buffer._id }, { $set: { status: 'receiving', error: message } });
		return { assembled: false, error: message, missing };
	}

	if (text.length > MAX_ASSEMBLED_BYTES) {
		const message = `assembled sweep is ${text.length} bytes, over the ${MAX_ASSEMBLED_BYTES} limit`;
		await SweepUpload.updateOne({ _id: buffer._id }, { $set: { status: 'failed', error: message } });
		return { assembled: false, error: message };
	}

	let decoded;
	try {
		decoded = decodeSweepPayload(text);
	} catch (e) {
		// Deterministic: resending the same bytes cannot fix it, so the buffer
		// stays 'failed' with its chunks intact for whoever debugs the firmware.
		const message = (e as Error).message;
		await SweepUpload.updateOne({ _id: buffer._id }, {
			$set: { status: 'failed', error: message, assembledBytes: text.length }
		});
		return { assembled: false, error: message };
	}

	const target = await resolveSweepSpu(decoded.spuToken, buffer.deviceId);
	if (!target) {
		// Recoverable by linking the device in BIMS, so the chunks are kept and
		// the buffer goes back to 'receiving' — any resent chunk retries it.
		const message = decoded.spuToken
			? `no SPU matches "${decoded.spuToken}" and device ${buffer.deviceId} is not linked to an SPU`
			: `device ${buffer.deviceId} is not linked to an SPU`;
		await SweepUpload.updateOne({ _id: buffer._id }, {
			$set: { status: 'receiving', error: message, assembledBytes: text.length }
		});
		return { assembled: false, error: message };
	}

	const { wells, wellNumbers, magResults } = summarise(decoded.analysisRows, decoded.end);
	const startedAt = new Date();

	// A column list that is not the locked spec is stored as sent and shouted
	// about — silently rewriting it to match would hide a firmware drift behind
	// data that looks correct.
	const warning = decoded.fieldSpecMismatch
		? `declared fields do not match the ${decoded.format} spec: ` +
			`expected [${decoded.fieldSpecMismatch.expected.join(',')}], ` +
			`got [${decoded.fieldSpecMismatch.actual.join(',')}]`
		: !decoded.fieldsDeclared
			? `payload declared no fields= header; assumed the ${decoded.format} spec`
			: undefined;

	if (warning) console.warn(`[mag-sweep ${buffer.deviceId}/${buffer.sweepId}] ${warning}`);

	const session = await ValidationSession.create({
		_id: generateId(),
		type: 'mag_sweep',
		spuId: target._id,
		spuUdi: target.udi,
		particleDeviceId: buffer.deviceId,
		status: 'completed',
		startedAt,
		completedAt: new Date(),
		userId: 'particle-webhook',
		// Verbatim capture: the device's own header/footer and every row exactly
		// as it sent them. rawData.fields names the columns of rawData.rows, so
		// a means upload and a raw upload are both self-describing.
		rawData: {
			format: decoded.format,
			meta: decoded.meta ?? null,
			end: decoded.end ?? null,
			sourceFile: `particle:${buffer.deviceId}/${buffer.sweepId}`,
			fields: decoded.fields,
			rows: decoded.rows,
			transport: {
				via: 'particle-webhook',
				sweepId: buffer.sweepId,
				chunks: buffer.totalChunks,
				bytes: text.length,
				deviceErrors: decoded.errors,
				// The fixed-point divisor that was undone on rows above; the
				// wire integers are rows x scale.
				scale: decoded.scale,
				// Rows the device emitted for a well that read nothing there.
				// It writes points x wells rows regardless so a receiver can
				// check completeness by counting, so these are kept in rows[]
				// and excluded from the analysis.
				rowsStored: decoded.rows.length,
				rowsAnalysed: decoded.analysisRows.length,
				rowsPlaceholder: decoded.placeholderRows,
				// fields[] above is whatever the device declared. These say
				// whether it declared anything at all, and how it differed from
				// the locked spec if it did.
				fieldsDeclared: decoded.fieldsDeclared,
				fieldSpecMismatch: decoded.fieldSpecMismatch
			}
		},
		magResults,
		// A sweep is a characterisation run, not a pass/fail gate.
		overallPassed: undefined,
		failureReasons: [],
		results: [{
			_id: generateId(),
			testType: 'magnetometer_sweep',
			processedData: { wells, wellNumbers },
			createdAt: new Date()
		}]
	});

	// Immutable audit entry only after the session write succeeds.
	await AuditLog.create({
		_id: generateId(),
		tableName: 'validation_sessions',
		recordId: session._id,
		action: 'INSERT',
		newData: {
			type: 'mag_sweep',
			spuId: target._id,
			spuUdi: target.udi,
			rows: decoded.rows.length,
			wells: wellNumbers,
			sourceFile: `particle:${buffer.deviceId}/${buffer.sweepId}`,
			format: decoded.format,
			fields: decoded.fields,
			scale: decoded.scale,
			rowsPlaceholder: decoded.placeholderRows,
			fieldSpecMismatch: decoded.fieldSpecMismatch
		},
		changedAt: new Date(),
		changedBy: 'particle-webhook'
	});

	// Chunks are redundant once the session holds every row verbatim.
	await SweepUpload.updateOne({ _id: buffer._id }, {
		$set: {
			status: 'completed',
			sessionId: session._id,
			spuId: target._id,
			spuUdi: target.udi,
			assembledBytes: text.length,
			completedAt: new Date(),
			chunks: {},
			error: null,
			warning: warning ?? null
		}
	});

	return {
		assembled: true,
		sessionId: session._id,
		spuId: target._id,
		spuUdi: target.udi,
		rowsIngested: decoded.rows.length,
		wells: wellNumbers,
		warning
	};
}

export async function handleSweepChunk(deviceId: string, rawData: unknown, at: Date) {
	let envelope: ChunkEnvelope;
	try {
		envelope = parseChunkEnvelope(rawData);
	} catch (e) {
		const message = (e as Error).message;
		await DeviceEvent.create({
			_id: generateId(),
			deviceId,
			eventType: 'mag_sweep_chunk',
			eventData: { malformed: true, reason: message },
			success: false,
			errorMessage: message,
			createdAt: at
		});
		return json({ success: false, error: message }, { status: 400 });
	}

	const key = `${deviceId}::${envelope.sweepId}`;

	// $set on the chunk's own path: a duplicate delivery rewrites the same key
	// with the same bytes, and chunks may therefore arrive in any order.
	const update = {
		$set: {
			[`chunks.${envelope.index}`]: envelope.slice,
			deviceId,
			sweepId: envelope.sweepId,
			totalChunks: envelope.total,
			lastChunkAt: at,
			expiresAt: new Date(Date.now() + SWEEP_BUFFER_TTL_MS)
		},
		$setOnInsert: { _id: generateId(), firstChunkAt: at, status: 'receiving' }
	};

	let buffer: any;
	try {
		buffer = await SweepUpload.findOneAndUpdate({ key }, update, { new: true, upsert: true }).lean();
	} catch (e: any) {
		// Two chunks of a brand-new sweep raced the upsert; the loser retries
		// against the row the winner just created.
		if (e?.code !== 11000) throw e;
		buffer = await SweepUpload.findOneAndUpdate({ key }, update, { new: true, upsert: true }).lean();
	}

	const stored: Record<string, string> = buffer?.chunks ?? {};
	const received = Object.keys(stored).length;
	const total = buffer?.totalChunks ?? envelope.total;

	await DeviceEvent.create({
		_id: generateId(),
		deviceId,
		eventType: 'mag_sweep_chunk',
		// The slice itself is not stored here: it lives in the buffer and then
		// verbatim in the session, and ~130 copies per sweep in an immutable log
		// is noise, not provenance.
		eventData: {
			sweepId: envelope.sweepId,
			index: envelope.index,
			total: envelope.total,
			bytes: envelope.slice.length,
			received
		},
		success: true,
		createdAt: at
	});

	// Already turned into a session; a late duplicate must not make a second one.
	if (buffer?.status === 'completed') {
		return json({
			success: true,
			event: 'mag_sweep_chunk',
			deviceId,
			sweepId: envelope.sweepId,
			received,
			total,
			missing: [],
			complete: true,
			sessionId: buffer.sessionId
		});
	}

	let result: AssembleResult | null = null;
	if (received >= total) {
		// Atomic claim: exactly one invocation may move a buffer out of
		// 'receiving', so the last two chunks landing together cannot both
		// assemble.
		const claimed = await SweepUpload.findOneAndUpdate(
			{ key, status: 'receiving' },
			{ $set: { status: 'assembling' } },
			{ new: true }
		).lean() as any;

		if (claimed) result = await assembleSweep(claimed);
	}

	const missing = assembleChunks(stored, total).missing;

	return json({
		success: true,
		event: 'mag_sweep_chunk',
		deviceId,
		sweepId: envelope.sweepId,
		received,
		total,
		// The device can resend exactly these indices instead of the whole sweep.
		missing: missing.slice(0, 50),
		complete: result?.assembled === true,
		sessionId: result?.sessionId,
		// Surface a stored failure too, so a device that keeps publishing into a
		// buffer we already gave up on is told why rather than seeing silence.
		error: result?.error ?? buffer?.error ?? undefined,
		warning: result?.warning
	});
}

