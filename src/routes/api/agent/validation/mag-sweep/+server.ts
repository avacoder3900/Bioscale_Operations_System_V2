import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, ValidationSession, Spu, AuditLog, generateId } from '$lib/server/db';
import { cleanRawRows, summarise, MAX_ROWS, RAW_FIELDS } from '$lib/server/validation/mag-sweep';
import type { RequestHandler } from './$types';

/**
 * Magnetometer stage-sweep ingest.
 *
 * The SPU streams sweep rows over serial (command 77), which never touches the
 * cloud. A bench-side pusher parses the SWPBEGIN/S/SWPEND text and POSTs it
 * here so the run lands in Mongo alongside normal validation sessions.
 *
 * Raw rows are stored verbatim for provenance; per-well/channel field summaries
 * are derived server-side so every consumer sees identical numbers. The
 * derivation itself lives in $lib/server/validation/mag-sweep so that this
 * path and the device's own Particle upload cannot drift apart.
 */

/**
 * Resolve an SPU from a human-supplied token without trusting a recalled id:
 * exact _id / udi / barcode first, then a unique udi suffix match. Ambiguous
 * tokens are rejected rather than silently picking one.
 */
async function resolveSpu(token: string) {
	const exact = await Spu.findOne({
		$or: [{ _id: token }, { udi: token }, { barcode: token }]
	}).lean() as any;
	if (exact) return exact;

	const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const matches = await Spu.find({ udi: { $regex: `${escaped}$` } }, { udi: 1 })
		.limit(5).lean() as any[];

	if (matches.length === 1) return await Spu.findById(matches[0]._id).lean() as any;
	if (matches.length > 1) {
		throw error(409, `Ambiguous SPU "${token}" — matches ${matches.map((m) => m.udi).join(', ')}`);
	}
	throw error(404, `No SPU matches "${token}"`);
}

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { spu, meta, end, rows, sourceFile, particleDeviceId, notes } = body ?? {};

	if (!spu || typeof spu !== 'string') {
		return json({ success: false, error: 'spu (udi, barcode, _id or udi suffix) is required' }, { status: 400 });
	}
	if (!Array.isArray(rows) || rows.length === 0) {
		return json({ success: false, error: 'rows[] is required and must be non-empty' }, { status: 400 });
	}
	if (rows.length > MAX_ROWS) {
		return json({ success: false, error: `rows[] exceeds ${MAX_ROWS}` }, { status: 413 });
	}

	const clean = cleanRawRows(rows);
	if (clean.length === 0) {
		return json({ success: false, error: `no row had ${RAW_FIELDS.length} numeric fields` }, { status: 400 });
	}

	const target = await resolveSpu(spu);

	const { wells, wellNumbers, magResults } = summarise(clean, end);

	const startedAt = new Date();

	const session = await ValidationSession.create({
		_id: generateId(),
		type: 'mag_sweep',
		spuId: target._id,
		spuUdi: target.udi,
		particleDeviceId: particleDeviceId || target?.particleLink?.particleDeviceId || undefined,
		status: 'completed',
		startedAt,
		completedAt: new Date(),
		userId: 'agent-api',
		// Verbatim capture: the firmware's own header/footer and every raw row.
		rawData: {
			format: 'spu-mag-sweep/v1',
			meta: meta ?? null,
			end: end ?? null,
			sourceFile: sourceFile ?? null,
			// Copied, not the shared array itself — nothing should be able to
			// reach the module constant through a stored document.
			fields: [...RAW_FIELDS],
			rows: clean
		},
		magResults,
		// A sweep is a characterisation run, not a pass/fail gate.
		overallPassed: undefined,
		failureReasons: [],
		results: [{
			_id: generateId(),
			testType: 'magnetometer_sweep',
			processedData: { wells, wellNumbers },
			notes: notes || undefined,
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
			rows: clean.length,
			wells: wellNumbers,
			sourceFile: sourceFile ?? null
		},
		changedAt: new Date(),
		changedBy: 'agent-api'
	});

	return json({
		success: true,
		data: {
			sessionId: session._id,
			spuId: target._id,
			spuUdi: target.udi,
			rowsIngested: clean.length,
			wells: wellNumbers,
			summary: wells
		}
	}, { status: 201 });
};

export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const sessionId = url.searchParams.get('sessionId');

	if (sessionId) {
		const session = await ValidationSession.findById(sessionId).lean() as any;
		if (!session || session.type !== 'mag_sweep') throw error(404, 'Sweep session not found');

		// Raw rows are large; only ship them when explicitly asked for.
		if (url.searchParams.get('raw') !== 'true' && session.rawData) {
			session.rawData = { ...session.rawData, rows: undefined, rowCount: session.rawData.rows?.length ?? 0 };
		}
		return json({ success: true, data: session });
	}

	const filter: Record<string, unknown> = { type: 'mag_sweep' };
	const spuToken = url.searchParams.get('spu');
	if (spuToken) filter.spuId = (await resolveSpu(spuToken))._id;

	const limit = Math.min(parseInt(url.searchParams.get('limit') || '25'), 100);
	const sessions = await ValidationSession.find(filter, {
		spuId: 1, spuUdi: 1, status: 1, startedAt: 1, completedAt: 1, magResults: 1, createdAt: 1
	}).sort({ createdAt: -1 }).limit(limit).lean() as any[];

	return json({ success: true, data: { sessions, count: sessions.length } });
};
