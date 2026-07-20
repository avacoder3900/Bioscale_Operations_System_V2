import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, GeneratedBarcode, Spu } from '$lib/server/db';
import { processThermoUpload, type ThermoReading } from '$lib/server/validation/thermo-upload';
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
		.select('-results.rawData')
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
		const fileName = form.get('fileName')?.toString() || null;
		const minTemp = Number(form.get('minTemp'));
		const maxTemp = Number(form.get('maxTemp'));

		if (!spuId) return fail(400, { error: 'Please select an SPU' });
		if (!readingsJson) return fail(400, { error: 'No temperature data uploaded' });
		if (isNaN(minTemp) || isNaN(maxTemp)) return fail(400, { error: 'Temperature range is required' });
		if (minTemp >= maxTemp) return fail(400, { error: 'Min must be less than max temperature' });

		let readings: ThermoReading[];
		try {
			readings = JSON.parse(readingsJson);
			if (!Array.isArray(readings) || readings.length === 0) {
				return fail(400, { error: 'No valid readings in uploaded data' });
			}
		} catch {
			return fail(400, { error: 'Invalid readings data' });
		}

		const outcome = await processThermoUpload({
			spuId,
			readings,
			criteria: { minTemp, maxTemp },
			fileName,
			user: { _id: locals.user!._id, username: locals.user!.username }
		});
		if ('error' in outcome) return fail(400, { error: outcome.error });

		return {
			success: true,
			sessionId: outcome.sessionId,
			results: {
				passed: outcome.passed ?? false,
				stats: outcome.stats,
				failureReasons: outcome.failureReasons
			}
		};
	}
};
