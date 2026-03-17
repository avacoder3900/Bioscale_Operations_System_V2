import { json } from '@sveltejs/kit';
import { connectDB, ValidationSession, AuditLog, generateId } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * POST /api/validation/thermocouple
 *
 * Receives captured thermocouple readings from the client-side ThermocoupleCapture component,
 * computes statistics, determines pass/fail, and persists to the ValidationSession.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	await connectDB();

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
	const min = Math.min(...temps);
	const max = Math.max(...temps);
	const sum = temps.reduce((a, b) => a + b, 0);
	const average = sum / temps.length;
	const variance = temps.reduce((acc, t) => acc + (t - average) ** 2, 0) / temps.length;
	const stdDev = Math.sqrt(variance);
	const range = max - min;
	const drift = temps.length >= 2 ? temps[temps.length - 1] - temps[0] : 0;

	const outOfRangeCount = temps.filter(t => t < config.minTemp || t > config.maxTemp).length;

	const durationMs = readings.length >= 2
		? readings[readings.length - 1].timestamp - readings[0].timestamp
		: 0;

	const stats = {
		min,
		max,
		average: Math.round(average * 1000) / 1000,
		stdDev: Math.round(stdDev * 1000) / 1000,
		range: Math.round(range * 1000) / 1000,
		drift: Math.round(drift * 1000) / 1000,
		readingCount: readings.length,
		outOfRangeCount,
		durationMs
	};

	// Determine pass/fail
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

	// Build result object
	const resultId = generateId();
	const result = {
		_id: resultId,
		testType: 'thermocouple',
		rawData: { readings },
		processedData: {
			stats,
			interpretation,
			failureReasons,
			criteria: { minTemp: config.minTemp, maxTemp: config.maxTemp }
		},
		passed,
		notes: interpretation,
		createdAt: new Date()
	};

	// Update session
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

	// Audit log
	await AuditLog.create({
		_id: generateId(),
		action: 'thermocouple_validation_complete',
		resourceType: 'validation_session',
		resourceId: sessionId,
		userId: locals.user._id,
		username: locals.user.username,
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
		stats,
		failureReasons,
		resultId
	});
};
