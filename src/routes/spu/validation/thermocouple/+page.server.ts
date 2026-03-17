import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, GeneratedBarcode, Spu, AuditLog, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// Load SPUs for dropdown
	const spus = await Spu.find({
		status: { $nin: ['voided', 'retired'] }
	})
		.select('_id udi status validation.thermocouple.status')
		.sort({ udi: 1 })
		.lean() as any[];

	// Load recent thermocouple sessions
	const sessions = await ValidationSession.find({ type: 'thermo' })
		.sort({ createdAt: -1 })
		.limit(10)
		.lean() as any[];

	const barcodeIds = sessions.map((s: any) => s.generatedBarcodeId).filter(Boolean);
	const barcodes = barcodeIds.length
		? await GeneratedBarcode.find({ _id: { $in: barcodeIds } }).lean() as any[]
		: [];
	const barcodeMap = new Map(barcodes.map((b: any) => [b._id, b.barcode]));

	return {
		spus: spus.map(s => ({
			id: s._id,
			udi: s.udi,
			status: s.status,
			thermoStatus: s.validation?.thermocouple?.status ?? null
		})),
		recentSessions: sessions.map((s: any) => {
			const thermoResult = s.results?.find((r: any) => r.testType === 'thermocouple');
			return {
				id: s._id,
				status: s.status,
				barcode: s.barcode ?? barcodeMap.get(s.generatedBarcodeId) ?? null,
				createdAt: s.createdAt?.toISOString() ?? new Date().toISOString(),
				spuUdi: s.spuUdi ?? null,
				stats: thermoResult?.processedData?.stats
					? {
						min: thermoResult.processedData.stats.min,
						max: thermoResult.processedData.stats.max,
						average: thermoResult.processedData.stats.average
					}
					: null
			};
		})
	};
};

export const actions: Actions = {
	upload: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		const readingsJson = form.get('readings')?.toString();
		const minTemp = Number(form.get('minTemp'));
		const maxTemp = Number(form.get('maxTemp'));

		if (!spuId) return fail(400, { error: 'Please select an SPU' });
		if (!readingsJson) return fail(400, { error: 'No temperature data uploaded' });
		if (isNaN(minTemp) || isNaN(maxTemp)) return fail(400, { error: 'Temperature range is required' });
		if (minTemp >= maxTemp) return fail(400, { error: 'Min must be less than max temperature' });

		let readings: Array<{ timestamp: number; temperature: number }>;
		try {
			readings = JSON.parse(readingsJson);
			if (!Array.isArray(readings) || readings.length === 0) {
				return fail(400, { error: 'No valid readings in uploaded data' });
			}
		} catch {
			return fail(400, { error: 'Invalid readings data' });
		}

		// Verify SPU exists
		const spu = await Spu.findById(spuId).lean() as any;
		if (!spu) return fail(400, { error: 'SPU not found' });

		// Compute stats
		const temps = readings.map(r => r.temperature);
		const min = Math.min(...temps);
		const max = Math.max(...temps);
		const sum = temps.reduce((a, b) => a + b, 0);
		const average = sum / temps.length;
		const variance = temps.reduce((acc, t) => acc + (t - average) ** 2, 0) / temps.length;
		const stdDev = Math.sqrt(variance);
		const cv = average !== 0 ? (stdDev / average) * 100 : 0;
		const range = max - min;
		const drift = temps.length >= 2 ? temps[temps.length - 1] - temps[0] : 0;
		const outOfRangeCount = temps.filter(t => t < minTemp || t > maxTemp).length;
		const durationMs = readings.length >= 2
			? readings[readings.length - 1].timestamp - readings[0].timestamp
			: 0;

		const stats = {
			min: Math.round(min * 1000) / 1000,
			max: Math.round(max * 1000) / 1000,
			average: Math.round(average * 1000) / 1000,
			stdDev: Math.round(stdDev * 1000) / 1000,
			cv: Math.round(cv * 1000) / 1000,
			range: Math.round(range * 1000) / 1000,
			drift: Math.round(drift * 1000) / 1000,
			readingCount: readings.length,
			outOfRangeCount,
			durationMs
		};

		// Pass/fail
		const passed = outOfRangeCount === 0;
		const failureReasons: string[] = [];
		if (temps.some(t => t < minTemp)) {
			failureReasons.push(`${temps.filter(t => t < minTemp).length} reading(s) below minimum ${minTemp}°C`);
		}
		if (temps.some(t => t > maxTemp)) {
			failureReasons.push(`${temps.filter(t => t > maxTemp).length} reading(s) above maximum ${maxTemp}°C`);
		}

		const interpretation = passed
			? `All ${readings.length} readings within acceptable range (${minTemp}°C - ${maxTemp}°C)`
			: `${outOfRangeCount} of ${readings.length} readings outside acceptable range`;

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
			startedAt: new Date(readings[0].timestamp),
			completedAt: new Date(),
			config: { minTemp, maxTemp },
			results: [{
				_id: resultId,
				testType: 'thermocouple',
				rawData: { readings },
				processedData: {
					stats,
					interpretation,
					failureReasons,
					criteria: { minTemp, maxTemp }
				},
				passed,
				notes: interpretation,
				createdAt: new Date()
			}]
		});

		// Update SPU validation.thermocouple
		await Spu.updateOne(
			{ _id: spuId },
			{
				$set: {
					'validation.thermocouple.status': passed ? 'passed' : 'failed',
					'validation.thermocouple.sessionId': sessionId,
					'validation.thermocouple.completedAt': new Date(),
					'validation.thermocouple.rawData': { readingCount: readings.length, fileName: null },
					'validation.thermocouple.results': stats,
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
				stats,
				failureReasons
			}
		});

		return {
			success: true,
			sessionId,
			results: { passed, stats, failureReasons }
		};
	}
};
