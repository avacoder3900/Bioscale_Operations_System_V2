import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, GeneratedBarcode, Spu } from '$lib/server/db';
import { processThermoUpload, recordThermoVerdict, type ThermoReading } from '$lib/server/validation/thermo-upload';
import { parseThermoFile } from '$lib/server/validation/parse-thermo-file';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// Load SPUs for dropdown
	const spus = await Spu.find({
		status: { $ne: 'retired' }
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
						mode: thermoResult.processedData.stats.mode ?? null,
						average: thermoResult.processedData.stats.average
					}
					: null
			};
		})
	};
};

// The chart only needs shape, not every sample. A 9,500-reading file would
// otherwise ship its whole array back through the form result.
function thinSeries(readings: ThermoReading[], maxPoints: number): ThermoReading[] {
	if (readings.length <= maxPoints) return readings;
	const step = readings.length / maxPoints;
	const out: ThermoReading[] = [];
	for (let i = 0; i < maxPoints; i++) out.push(readings[Math.floor(i * step)]);
	out.push(readings[readings.length - 1]);
	return out;
}

export const actions: Actions = {
	// Step 1 — the file is the record. It is posted whole, read here, and saved
	// as an unjudged session. Nothing parses on the client, so the numbers the
	// operator reviews are exactly the numbers that were persisted.
	upload: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		const file = form.get('file');
		const tzOffsetRaw = form.get('tzOffset')?.toString() ?? '';

		if (!spuId) return fail(400, { error: 'Please select an SPU' });
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { error: 'Choose a thermocouple file to upload' });
		}

		// The operator's UTC offset, so the logger's naive timestamps resolve on
		// the same timeline as every session already recorded from a browser.
		const tzOffsetMinutes = tzOffsetRaw !== '' && Number.isFinite(Number(tzOffsetRaw))
			? Number(tzOffsetRaw)
			: undefined;

		const parsed = parseThermoFile(new Uint8Array(await file.arrayBuffer()), { tzOffsetMinutes });
		if ('error' in parsed) return fail(400, { error: parsed.error });

		const outcome = await processThermoUpload({
			spuId,
			readings: parsed.readings,
			fileName: file.name,
			user: { _id: locals.user!._id, username: locals.user!.username }
		});
		if ('error' in outcome) return fail(400, { error: outcome.error });

		return {
			uploaded: true,
			sessionId: outcome.sessionId,
			barcode: outcome.barcode,
			spuUdi: outcome.spuUdi,
			fileName: file.name,
			columnsNote: parsed.columnsNote,
			stats: outcome.stats,
			series: thinSeries(parsed.readings, 800)
		};
	},

	// Step 2 — the verdict, recorded against the session id created above. It
	// cannot reach another SPU's data: the id names the readings it judges.
	verdict: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const sessionId = form.get('sessionId')?.toString();
		const choice = form.get('outcome')?.toString();

		if (!sessionId) return fail(400, { error: 'No uploaded session to record a verdict against' });
		if (choice !== 'passed' && choice !== 'failed') {
			return fail(400, { error: 'Record a Pass or Fail verdict' });
		}

		const outcome = await recordThermoVerdict({
			sessionId,
			verdict: choice,
			user: { _id: locals.user!._id, username: locals.user!.username }
		});
		if ('error' in outcome) return fail(400, { error: outcome.error });

		return {
			success: true,
			sessionId,
			barcode: outcome.barcode,
			spuUdi: outcome.spuUdi,
			passed: outcome.passed
		};
	}
};
