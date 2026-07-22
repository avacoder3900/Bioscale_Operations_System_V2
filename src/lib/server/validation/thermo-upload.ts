import { ValidationSession, GeneratedBarcode, Spu, AuditLog, generateId } from '$lib/server/db';
import { computeChannelStats, type ChannelStats } from '$lib/server/thermocouple-stats';
import type { ThermoCriteria } from './thermo-criteria.js';

export interface ThermoReading {
	timestamp: number;
	temperature: number;
}

export interface ThermoStats extends ChannelStats {
	durationMs: number;
}

export interface ThermoUploadOutcome {
	sessionId: string;
	barcode: string;
	spuUdi: string;
	stats: ThermoStats;
	evaluated: boolean;
	passed: boolean | null;
	failureReasons: string[];
}

export interface ThermoEvalOutcome {
	sessionId: string;
	stats: ThermoStats;
	passed: boolean;
	failureReasons: string[];
	criteria: ThermoCriteria;
}

function evaluateReadings(temps: number[], criteria: ThermoCriteria) {
	const stats = computeChannelStats(temps, criteria.minTemp, criteria.maxTemp);
	const passed = stats.outOfRangeCount === 0;
	const failureReasons: string[] = [];
	if (temps.some(t => t < criteria.minTemp)) {
		failureReasons.push(`${temps.filter(t => t < criteria.minTemp).length} reading(s) below minimum ${criteria.minTemp}°C`);
	}
	if (temps.some(t => t > criteria.maxTemp)) {
		failureReasons.push(`${temps.filter(t => t > criteria.maxTemp).length} reading(s) above maximum ${criteria.maxTemp}°C`);
	}
	const interpretation = passed
		? `All ${temps.length} readings within acceptable range (${criteria.minTemp}°C - ${criteria.maxTemp}°C)`
		: `${stats.outOfRangeCount} of ${temps.length} readings outside acceptable range`;
	return { stats, passed, failureReasons, interpretation };
}

/**
 * The thermocouple upload pipeline (extracted verbatim from the standalone
 * /validation/thermocouple `upload` action): stats → THERMO- barcode →
 * ValidationSession → spu.validation.thermocouple rollup → audit.
 *
 * With `criteria` set, behavior is identical to the standalone page: pass/fail
 * is computed at upload. With `criteria: null` (validation-run uploads while
 * the standard range is unconfigured), the data is recorded but NOT judged:
 * the session is left 'in_progress' and the SPU rollup status stays 'pending'
 * until evaluateThermoSession() runs (VALIDATION-05: upload ≠ pass).
 */
export async function processThermoUpload(opts: {
	spuId: string;
	readings: ThermoReading[];
	criteria: ThermoCriteria | null;
	runId?: string;
	fileName?: string | null;
	user: { _id: string; username: string };
}): Promise<{ error: string } | ThermoUploadOutcome> {
	const { spuId, readings, criteria, runId, fileName, user } = opts;

	if (!Array.isArray(readings) || readings.length === 0) {
		return { error: 'No valid readings in uploaded data' };
	}

	const spu = await Spu.findById(spuId).lean() as any;
	if (!spu) return { error: 'SPU not found' };
	if (spu.finalizedAt) return { error: 'SPU is finalized and cannot be modified' };

	const temps = readings.map(r => r.temperature);

	// Sanity guard: a correct parse yields temperatures, not Excel date
	// serials (~46,000) or row indexes. Reject implausible data instead of
	// recording a garbage session (old sessions THERMO-000005/6 did exactly
	// that: "temperatures" 1..493 from a row-index column).
	const implausible = temps.filter(t => !isFinite(t) || t < -100 || t > 1000).length;
	if (implausible / temps.length > 0.2) {
		return { error: `Parsed values do not look like temperatures (${implausible} of ${temps.length} outside -100…1000°C) — check the file's column layout and re-upload` };
	}
	const durationMs = readings.length >= 2
		? readings[readings.length - 1].timestamp - readings[0].timestamp
		: 0;

	let stats: ChannelStats;
	let passed: boolean | null = null;
	let failureReasons: string[] = [];
	let interpretation: string;
	if (criteria) {
		const ev = evaluateReadings(temps, criteria);
		stats = ev.stats;
		passed = ev.passed;
		failureReasons = ev.failureReasons;
		interpretation = ev.interpretation;
	} else {
		// No acceptance range yet — stats only, no out-of-range judgment.
		stats = computeChannelStats(temps, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
		interpretation = `${readings.length} readings uploaded, awaiting evaluation against the standard acceptance range`;
	}

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

	const sessionId = generateId();
	await ValidationSession.create({
		_id: sessionId,
		type: 'thermo',
		status: criteria ? (passed ? 'completed' : 'failed') : 'in_progress',
		userId: user._id,
		generatedBarcodeId: barcodeId,
		barcode,
		spuId,
		spuUdi: spu.udi,
		runId: runId ?? null,
		startedAt: new Date(readings[0].timestamp),
		completedAt: criteria ? new Date() : null,
		config: criteria ? { minTemp: criteria.minTemp, maxTemp: criteria.maxTemp } : {},
		results: [{
			_id: generateId(),
			testType: 'thermocouple',
			rawData: { readings },
			processedData: {
				stats: { ...stats, durationMs },
				interpretation,
				failureReasons,
				criteria: criteria ? { minTemp: criteria.minTemp, maxTemp: criteria.maxTemp } : null
			},
			passed,
			notes: interpretation,
			createdAt: new Date()
		}]
	});

	// SPU rollup: sacred-gated write first (may throw on finalized), audit after.
	// Rollup status enum has no 'uploaded' — it stays 'pending' until evaluation.
	const rollup: Record<string, unknown> = {
		'validation.thermocouple.sessionId': sessionId,
		'validation.thermocouple.rawData': { readingCount: readings.length, fileName: fileName ?? null },
		'validation.thermocouple.results': { ...stats, durationMs }
	};
	if (criteria) {
		rollup['validation.thermocouple.status'] = passed ? 'passed' : 'failed';
		rollup['validation.thermocouple.completedAt'] = new Date();
		rollup['validation.thermocouple.failureReasons'] = failureReasons;
		rollup['validation.thermocouple.criteriaUsed'] = { minTemp: criteria.minTemp, maxTemp: criteria.maxTemp };
	}
	await Spu.updateOne({ _id: spuId }, { $set: rollup });

	await AuditLog.create({
		_id: generateId(),
		tableName: 'validation_sessions',
		recordId: sessionId,
		action: 'thermocouple_validation_upload',
		newData: {
			spuId,
			spuUdi: spu.udi,
			barcode,
			runId: runId ?? null,
			fileName: fileName ?? null,
			evaluated: !!criteria,
			passed,
			stats: { ...stats, durationMs },
			failureReasons
		},
		changedAt: new Date(),
		changedBy: user.username
	});

	return {
		sessionId,
		barcode,
		spuUdi: spu.udi,
		stats: { ...stats, durationMs },
		evaluated: !!criteria,
		passed,
		failureReasons
	};
}

/**
 * VALIDATION-05: judge an already-uploaded thermocouple session against an
 * acceptance range. Re-runs computeChannelStats over the stored readings,
 * completes the session, and flips the SPU rollup to passed/failed.
 */
export async function evaluateThermoSession(opts: {
	sessionId: string;
	criteria: ThermoCriteria;
	user: { _id: string; username: string };
}): Promise<{ error: string } | ThermoEvalOutcome> {
	const { sessionId, criteria, user } = opts;

	const session = await ValidationSession.findById(sessionId).lean() as any;
	if (!session) return { error: 'Validation session not found' };
	const result = session.results?.find((r: any) => r.testType === 'thermocouple');
	const readings: ThermoReading[] = result?.rawData?.readings ?? [];
	if (readings.length === 0) return { error: 'Session has no stored readings to evaluate' };

	const spu = session.spuId ? await Spu.findById(session.spuId).lean() as any : null;
	if (spu?.finalizedAt) return { error: 'SPU is finalized and cannot be modified' };

	const temps = readings.map(r => r.temperature);
	const durationMs = readings.length >= 2
		? readings[readings.length - 1].timestamp - readings[0].timestamp
		: 0;
	const { stats, passed, failureReasons, interpretation } = evaluateReadings(temps, criteria);
	const previousPassed = result?.passed ?? null;

	await ValidationSession.updateOne(
		{ _id: sessionId, 'results._id': result._id },
		{
			$set: {
				status: passed ? 'completed' : 'failed',
				completedAt: new Date(),
				overallPassed: passed,
				failureReasons,
				criteriaUsed: { minTemp: criteria.minTemp, maxTemp: criteria.maxTemp },
				config: { minTemp: criteria.minTemp, maxTemp: criteria.maxTemp },
				'results.$.passed': passed,
				'results.$.notes': interpretation,
				'results.$.processedData.stats': { ...stats, durationMs },
				'results.$.processedData.interpretation': interpretation,
				'results.$.processedData.failureReasons': failureReasons,
				'results.$.processedData.criteria': { minTemp: criteria.minTemp, maxTemp: criteria.maxTemp }
			}
		}
	);

	if (session.spuId) {
		await Spu.updateOne(
			{ _id: session.spuId },
			{
				$set: {
					'validation.thermocouple.status': passed ? 'passed' : 'failed',
					'validation.thermocouple.sessionId': sessionId,
					'validation.thermocouple.completedAt': new Date(),
					'validation.thermocouple.results': { ...stats, durationMs },
					'validation.thermocouple.failureReasons': failureReasons,
					'validation.thermocouple.criteriaUsed': { minTemp: criteria.minTemp, maxTemp: criteria.maxTemp }
				}
			}
		);
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'validation_sessions',
		recordId: sessionId,
		action: 'thermocouple_validation_evaluated',
		oldData: { passed: previousPassed },
		newData: {
			spuId: session.spuId ?? null,
			spuUdi: session.spuUdi ?? null,
			criteria: { minTemp: criteria.minTemp, maxTemp: criteria.maxTemp },
			passed,
			stats: { ...stats, durationMs },
			failureReasons
		},
		changedAt: new Date(),
		changedBy: user.username
	});

	return { sessionId, stats: { ...stats, durationMs }, passed, failureReasons, criteria };
}
