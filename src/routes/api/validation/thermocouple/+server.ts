import { json } from '@sveltejs/kit';
import { connectDB, ValidationSession, GeneratedBarcode, Spu, AuditLog, generateId } from '$lib/server/db';
import { parseThermocoupleXlsx } from '$lib/server/thermocouple-xlsx-parser';
import { computeChannelStats, computeOverallStats, determinePassFail } from '$lib/server/thermocouple-stats';
import { generateChannelChartSvg } from '$lib/server/thermocouple-chart';
import type { RequestHandler } from './$types';

/**
 * POST /api/validation/thermocouple
 *
 * Accepts either:
 * 1. multipart/form-data with an xlsx file (multi-channel workflow)
 * 2. JSON body with pre-parsed readings (legacy single-channel workflow)
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	await connectDB();

	const contentType = request.headers.get('content-type') || '';

	if (contentType.includes('multipart/form-data')) {
		return handleXlsxUpload(request, locals);
	} else {
		return handleLegacyJson(request, locals);
	}
};

async function handleXlsxUpload(request: Request, locals: App.Locals) {
	const form = await request.formData();
	const file = form.get('file') as File | null;
	const spuId = form.get('spuId')?.toString();
	const minTemp = Number(form.get('minTemp'));
	const maxTemp = Number(form.get('maxTemp'));

	if (!file) return json({ error: 'No file uploaded' }, { status: 400 });
	if (!spuId) return json({ error: 'spuId is required' }, { status: 400 });
	if (isNaN(minTemp) || isNaN(maxTemp)) return json({ error: 'minTemp and maxTemp are required' }, { status: 400 });
	if (minTemp >= maxTemp) return json({ error: 'minTemp must be less than maxTemp' }, { status: 400 });

	const spu = await Spu.findById(spuId).lean() as any;
	if (!spu) return json({ error: 'SPU not found' }, { status: 400 });

	// Read and store the raw xlsx file as base64
	const fileBuffer = Buffer.from(await file.arrayBuffer());
	const fileBase64 = fileBuffer.toString('base64');

	// Parse xlsx
	let parsed;
	try {
		parsed = parseThermocoupleXlsx(fileBuffer, file.name);
	} catch (err: any) {
		return json({ error: `Failed to parse xlsx: ${err.message}` }, { status: 400 });
	}

	// Compute per-channel stats
	const channelStats: Record<string, ReturnType<typeof computeChannelStats>> = {};
	for (const ch of ['ch1', 'ch2', 'ch3', 'ch4'] as const) {
		channelStats[ch] = computeChannelStats(parsed.channels[ch], minTemp, maxTemp);
	}

	const overallStats = computeOverallStats(channelStats);
	const { passed, failureReasons, interpretation, perChannel } = determinePassFail(channelStats, minTemp, maxTemp);

	// Generate SVG charts for each channel
	const channelsData: Record<string, any> = {};
	for (const ch of ['ch1', 'ch2', 'ch3', 'ch4'] as const) {
		const chartSvg = generateChannelChartSvg(ch, parsed.channels[ch], parsed.num, minTemp, maxTemp, channelStats[ch]);
		channelsData[ch] = {
			stats: channelStats[ch],
			passed: perChannel[ch],
			chartSvg
		};
	}

	// Generate barcode
	const barcodeDoc = await GeneratedBarcode.findOneAndUpdate(
		{ prefix: 'THERMO' },
		{ $inc: { sequence: 1 } },
		{ upsert: true, new: true, setDefaultsOnInsert: true }
	);
	const seq = (barcodeDoc as any).sequence ?? 1;
	const barcode = `THERMO-${String(seq).padStart(6, '0')}`;

	const barcodeId = generateId();
	await GeneratedBarcode.create({
		_id: barcodeId,
		prefix: 'THERMO',
		sequence: seq,
		barcode,
		type: 'validation_thermo'
	});

	// Build backward-compatible readings array from ch1 for legacy UI
	const legacyReadings = parsed.channels.ch1.map((temp, i) => ({
		timestamp: Date.now() + i * 1000,
		temperature: temp
	}));

	// Create validation session
	const sessionId = generateId();
	const resultId = generateId();
	await ValidationSession.create({
		_id: sessionId,
		type: 'thermo',
		status: passed ? 'completed' : 'failed',
		userId: locals.user!._id,
		generatedBarcodeId: barcodeId,
		barcode,
		spuId,
		spuUdi: spu.udi,
		startedAt: new Date(),
		completedAt: new Date(),
		config: { minTemp, maxTemp },
		results: [{
			_id: resultId,
			testType: 'thermocouple',
			rawData: {
				readings: legacyReadings,
				channels: parsed.channels,
				num: parsed.num,
				fileName: parsed.fileName,
				xlsxFile: fileBase64,
				xlsxMimeType: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
			},
			processedData: {
				stats: overallStats,
				channels: channelsData,
				interpretation,
				failureReasons,
				criteria: { minTemp, maxTemp }
			},
			passed,
			notes: interpretation,
			createdAt: new Date()
		}]
	});

	// Update SPU validation
	await Spu.updateOne(
		{ _id: spuId },
		{
			$set: {
				'validation.thermocouple.status': passed ? 'passed' : 'failed',
				'validation.thermocouple.sessionId': sessionId,
				'validation.thermocouple.completedAt': new Date(),
				'validation.thermocouple.rawData': { readingCount: parsed.rowCount, fileName: parsed.fileName },
				'validation.thermocouple.results': overallStats,
				'validation.thermocouple.failureReasons': failureReasons,
				'validation.thermocouple.criteriaUsed': { minTemp, maxTemp }
			}
		}
	);

	// Audit log
	await AuditLog.create({
		_id: generateId(),
		action: 'thermocouple_validation_upload',
		resourceType: 'validation_session',
		resourceId: sessionId,
		userId: locals.user!._id,
		username: locals.user!.username,
		timestamp: new Date(),
		details: {
			spuId,
			spuUdi: spu.udi,
			barcode,
			passed,
			stats: overallStats,
			channelStats,
			failureReasons
		}
	});

	return json({
		success: true,
		sessionId,
		barcode,
		passed,
		stats: overallStats,
		channelStats,
		failureReasons,
		chartUrls: {
			ch1: `/api/validation/thermocouple/${sessionId}/chart/ch1`,
			ch2: `/api/validation/thermocouple/${sessionId}/chart/ch2`,
			ch3: `/api/validation/thermocouple/${sessionId}/chart/ch3`,
			ch4: `/api/validation/thermocouple/${sessionId}/chart/ch4`
		}
	});
}

async function handleLegacyJson(request: Request, locals: App.Locals) {
	const body = await request.json();
	const { sessionId, readings, config } = body as {
		sessionId: string;
		readings: Array<{ timestamp: number; temperature: number; unit?: string }>;
		config: { durationSeconds: number; intervalSeconds: number; minTemp: number; maxTemp: number };
	};

	if (!sessionId) return json({ error: 'sessionId is required' }, { status: 400 });
	if (!readings || !Array.isArray(readings) || readings.length === 0) {
		return json({ error: 'readings array is required and must not be empty' }, { status: 400 });
	}
	if (!config) return json({ error: 'config is required' }, { status: 400 });

	const session = await ValidationSession.findById(sessionId) as any;
	if (!session) return json({ error: 'Session not found' }, { status: 404 });

	// Compute statistics
	const temps = readings.map(r => r.temperature);
	const stats = computeChannelStats(temps, config.minTemp, config.maxTemp);

	const durationMs = readings.length >= 2
		? readings[readings.length - 1].timestamp - readings[0].timestamp
		: 0;

	const outOfRangeCount = stats.outOfRangeCount;
	const passed = outOfRangeCount === 0;
	const failureReasons: string[] = [];
	if (!passed) {
		if (temps.some(t => t < config.minTemp)) {
			failureReasons.push(`${temps.filter(t => t < config.minTemp).length} reading(s) below minimum ${config.minTemp}°C`);
		}
		if (temps.some(t => t > config.maxTemp)) {
			failureReasons.push(`${temps.filter(t => t > config.maxTemp).length} reading(s) above maximum ${config.maxTemp}°C`);
		}
	}

	const interpretation = passed
		? `All ${readings.length} readings within acceptable range (${config.minTemp}°C - ${config.maxTemp}°C)`
		: `${outOfRangeCount} of ${readings.length} readings outside acceptable range`;

	const resultId = generateId();
	const result = {
		_id: resultId,
		testType: 'thermocouple',
		rawData: { readings },
		processedData: {
			stats: { ...stats, durationMs },
			interpretation,
			failureReasons,
			criteria: { minTemp: config.minTemp, maxTemp: config.maxTemp }
		},
		passed,
		notes: interpretation,
		createdAt: new Date()
	};

	await ValidationSession.updateOne(
		{ _id: sessionId },
		{
			$set: {
				status: passed ? 'completed' : 'failed',
				startedAt: session.startedAt ?? new Date(readings[0].timestamp),
				completedAt: new Date()
			},
			$push: { results: result }
		}
	);

	await AuditLog.create({
		_id: generateId(),
		action: 'thermocouple_validation_complete',
		resourceType: 'validation_session',
		resourceId: sessionId,
		userId: locals.user!._id,
		username: locals.user!.username,
		timestamp: new Date(),
		details: {
			passed,
			readingCount: readings.length,
			stats,
			failureReasons
		}
	});

	return json({
		success: true,
		passed,
		stats: { ...stats, durationMs },
		failureReasons,
		resultId
	});
}
