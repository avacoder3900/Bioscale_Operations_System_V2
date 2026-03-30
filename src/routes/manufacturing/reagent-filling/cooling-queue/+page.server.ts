import { redirect } from '@sveltejs/kit';
import { connectDB, CartridgeRecord, ManufacturingSettings } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const config = { maxDuration: 60 };

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	try {
	await connectDB();

	const [settingsDoc, coolingCartridges] = await Promise.all([
		ManufacturingSettings.findById('default').lean(),
		// Cartridges that are sealed/inspected and waiting in cooling before final storage
		CartridgeRecord.find({
			status: { $in: ['sealed', 'inspected', 'reagent_filled'] }
		}).sort({ 'reagentFilling.fillDate': -1 }).limit(200).lean()
	]);

	const requiredMinutes: number = (settingsDoc as any)?.reagentFilling?.minCoolingTimeMin ?? 30;
	const now = Date.now();

	// The svelte expects:
	// cartridgeId, waxRunId, qcTimestamp, coolingElapsedMin, minutesRemaining, isReady
	const cartridges = (coolingCartridges as any[]).map((c) => {
		// Use the reagent filling date as cooling start time
		const startedAt = c.reagentFilling?.fillDate
			? new Date(c.reagentFilling.fillDate)
			: c.reagentFilling?.recordedAt
				? new Date(c.reagentFilling.recordedAt)
				: c.updatedAt
					? new Date(c.updatedAt)
					: null;

		const coolingElapsedMin = startedAt ? (now - startedAt.getTime()) / 60000 : 0;
		const isReady = coolingElapsedMin >= requiredMinutes;
		const minutesRemaining = isReady ? 0 : Math.ceil(requiredMinutes - coolingElapsedMin);

		// waxRunId from the waxFilling phase
		const waxRunId = c.waxFilling?.runId ?? null;

		// qcTimestamp: when was it inspected
		const qcTimestamp = c.reagentInspection?.timestamp
			? new Date(c.reagentInspection.timestamp).toISOString()
			: startedAt
				? startedAt.toISOString()
				: null;

		return {
			cartridgeId: String(c._id),
			waxRunId,
			qcTimestamp,
			coolingElapsedMin: Math.round(coolingElapsedMin),
			minutesRemaining,
			isReady
		};
	});

	return { cartridges };
	} catch (err) {
		console.error('[REAGENT-FILLING COOLING-QUEUE] Load error:', err instanceof Error ? err.message : err);
		return { cartridges: [] };
	}
};
