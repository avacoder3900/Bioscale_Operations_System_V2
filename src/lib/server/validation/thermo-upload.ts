import { ValidationSession, GeneratedBarcode, Spu, AuditLog, generateId } from '$lib/server/db';
import { computeChannelStats, type ChannelStats } from '$lib/server/thermocouple-stats';
import { inCurrentCycle } from '$lib/server/spu-validation-cycle';

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

/**
 * The thermocouple upload pipeline: stats → THERMO- barcode →
 * ValidationSession → spu.validation.thermocouple rollup → audit.
 *
 * There is no acceptance range. Nothing is auto-judged and nothing waits on a
 * range being configured: the operator's Pass/Fail IS the record. Stats are
 * always computed for them to judge on.
 *
 *  - no `verdict`: the readings are stored and the session sits 'in_progress'
 *    until someone records a call (from the run board, or the session page).
 *  - `verdict`: judged on the spot, exactly as recordThermoVerdict() would.
 */
export async function processThermoUpload(opts: {
	spuId: string;
	readings: ThermoReading[];
	verdict?: 'passed' | 'failed' | null;
	runId?: string;
	fileName?: string | null;
	user: { _id: string; username: string };
}): Promise<{ error: string } | ThermoUploadOutcome> {
	const { spuId, readings, verdict, runId, fileName, user } = opts;

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

	// Unbounded: there is no range, so nothing is ever "out of range".
	const stats = computeChannelStats(temps, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
	let passed: boolean | null = null;
	let failureReasons: string[] = [];
	let interpretation: string;
	if (verdict) {
		passed = verdict === 'passed';
		interpretation = passed
			? `${readings.length} readings — passed on operator review of the min/max/mode shown`
			: `${readings.length} readings — failed on operator review of the min/max/mode shown`;
		if (!passed) failureReasons = ['Failed on operator review'];
	} else {
		interpretation = `${readings.length} readings uploaded — awaiting the operator's Pass/Fail`;
	}

	// A session is complete once a person has judged it.
	const judged = !!verdict;

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
		status: judged ? (passed ? 'completed' : 'failed') : 'in_progress',
		userId: user._id,
		generatedBarcodeId: barcodeId,
		barcode,
		spuId,
		spuUdi: spu.udi,
		runId: runId ?? null,
		startedAt: new Date(readings[0].timestamp),
		completedAt: judged ? new Date() : null,
		config: {},
		results: [{
			_id: generateId(),
			testType: 'thermocouple',
			rawData: { readings },
			processedData: {
				stats: { ...stats, durationMs },
				interpretation,
				failureReasons,
				criteria: null
			},
			passed,
			notes: interpretation,
			createdAt: new Date()
		}]
	});

	// SPU rollup: sacred-gated write first (may throw on finalized), audit after.
	// Rollup status enum has no 'uploaded' — it stays 'pending' until judged.
	const rollup: Record<string, unknown> = {
		'validation.thermocouple.sessionId': sessionId,
		'validation.thermocouple.rawData': { readingCount: readings.length, fileName: fileName ?? null },
		'validation.thermocouple.results': { ...stats, durationMs }
	};
	if (judged) {
		rollup['validation.thermocouple.status'] = passed ? 'passed' : 'failed';
		rollup['validation.thermocouple.completedAt'] = new Date();
		rollup['validation.thermocouple.failureReasons'] = failureReasons;
	}
	await Spu.updateOne({ _id: spuId }, { $set: rollup });

	// Evidence drives the evidence state (SPU-INV-12).
	const { autoEnterValidating } = await import('$lib/server/spu-auto-validate');
	await autoEnterValidating(spuId, 'thermocouple', user);

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
			evaluated: judged,
			verdict: verdict ?? null,
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
		evaluated: judged,
		passed,
		failureReasons
	};
}

export interface ThermoVerdictOutcome {
	sessionId: string;
	barcode: string | null;
	spuUdi: string | null;
	passed: boolean;
	stats: ThermoStats | null;
	failureReasons: string[];
}

/**
 * Record the operator's binary Pass/Fail against a session that has already
 * been uploaded and is awaiting judgment.
 *
 * The verdict is keyed on the session `_id`, so it lands on the readings that
 * were actually stored under it. There is no longer any path by which a
 * verdict reaches a different SPU's data than the data shown beside it — which
 * is how THERMO-000031 came to carry SPU 247's measurement.
 *
 * Also sets top-level `overallPassed`, which the upload path never did.
 */
export async function recordThermoVerdict(opts: {
	sessionId: string;
	verdict: 'passed' | 'failed';
	user: { _id: string; username: string };
}): Promise<{ error: string } | ThermoVerdictOutcome> {
	const { sessionId, verdict, user } = opts;
	const passed = verdict === 'passed';

	const session = await ValidationSession.findById(sessionId).lean() as any;
	if (!session) return { error: 'Validation session not found' };
	if (session.type !== 'thermo') return { error: 'That session is not a thermocouple session' };

	const result = session.results?.find((r: any) => r.testType === 'thermocouple');
	if (!result) return { error: 'That session has no thermocouple result to judge' };
	if (result.passed === true || result.passed === false) {
		return { error: 'That session already carries a verdict' };
	}

	const spu = session.spuId ? await Spu.findById(session.spuId).lean() as any : null;
	if (spu?.finalizedAt) return { error: 'SPU is finalized and cannot be modified' };

	const stats: ThermoStats | null = result.processedData?.stats ?? null;
	const readingCount = stats?.readingCount ?? result.rawData?.readings?.length ?? 0;
	const interpretation = passed
		? `${readingCount} readings — passed on operator review of the min/max/mode shown`
		: `${readingCount} readings — failed on operator review of the min/max/mode shown`;
	const failureReasons = passed ? [] : ['Failed on operator review'];
	const now = new Date();

	await ValidationSession.updateOne(
		{ _id: sessionId, 'results._id': result._id },
		{
			$set: {
				status: passed ? 'completed' : 'failed',
				completedAt: now,
				overallPassed: passed,
				failureReasons,
				'results.$.passed': passed,
				'results.$.notes': interpretation,
				'results.$.processedData.interpretation': interpretation,
				'results.$.processedData.failureReasons': failureReasons
			}
		}
	);

	// Readings uploaded before the unit's current validation cycle began (it
	// went to servicing since) get their verdict on the session but earn no
	// credit on the unit — the cycle needs a fresh thermocouple run.
	if (session.spuId && inCurrentCycle(session.startedAt, spu?.validationResetAt)) {
		await Spu.updateOne(
			{ _id: session.spuId },
			{
				$set: {
					'validation.thermocouple.status': passed ? 'passed' : 'failed',
					'validation.thermocouple.sessionId': sessionId,
					'validation.thermocouple.completedAt': now,
					'validation.thermocouple.failureReasons': failureReasons
				}
			}
		);
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'validation_sessions',
		recordId: sessionId,
		action: 'thermocouple_validation_verdict',
		newData: {
			spuId: session.spuId ?? null,
			spuUdi: session.spuUdi ?? null,
			barcode: session.barcode ?? null,
			verdict,
			passed,
			stats,
			failureReasons
		},
		changedAt: now,
		changedBy: user.username
	});

	return {
		sessionId,
		barcode: session.barcode ?? null,
		spuUdi: session.spuUdi ?? null,
		passed,
		stats,
		failureReasons
	};
}
