import { redirect, fail } from '@sveltejs/kit';
import { connectDB, WaxFillingRun, ManufacturingSettings } from '$lib/server/db';
import { isAdmin as checkAdmin } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const config = { maxDuration: 60 };

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	try {
		await connectDB();

		const [settingsDoc, completedRuns] = await Promise.all([
			ManufacturingSettings.findById('default').lean(),
			// Runs that have entered the oven (have ovenLocationId set and are completed/storage)
			WaxFillingRun.find({
				status: { $in: ['completed', 'storage', 'Storage'] },
				ovenLocationId: { $exists: true, $ne: null }
			}).sort({ runEndTime: -1 }).limit(50).lean()
		]);

		const minOvenTimeMin: number = (settingsDoc as any)?.waxFilling?.minOvenTimeMin ?? 60;
		const now = Date.now();

		const lots = (completedRuns as any[]).map((r) => {
			const ovenEntryTime = r.runEndTime ? new Date(r.runEndTime) : new Date(r.createdAt);
			const readyAt = new Date(ovenEntryTime.getTime() + minOvenTimeMin * 60 * 1000);
			const readyAtMs = readyAt.getTime();
			const ready = now >= readyAtMs;
			const minutesRemaining = ready ? 0 : Math.ceil((readyAtMs - now) / 60_000);

			return {
				lotId: String(r._id),
				configId: r.robot?.name ?? (r.robot?._id ? String(r.robot._id) : ''),
				ovenEntryTime: ovenEntryTime.toISOString(),
				readyAt: readyAt.toISOString(),
				minutesRemaining,
				ready
			};
		});

		return {
			lots,
			minOvenTimeMin,
			isAdmin: checkAdmin(locals.user)
		};
	} catch (err) {
		console.error('[WAX-FILLING OVEN-QUEUE] Load error:', err instanceof Error ? err.message : err);
		return { lots: [], minOvenTimeMin: 60, isAdmin: checkAdmin(locals.user) };
	}
};

export const actions: Actions = {
	/** Admin override: mark a lot as ready regardless of oven time */
	adminOverride: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		if (!checkAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		const reason = data.get('reason') as string;

		if (!reason?.trim()) return fail(400, { error: 'Reason is required for admin override' });

		// Move the oven entry time back to force it to appear ready
		const minOvenTimeMin = 60; // default
		const forcedEntryTime = new Date(Date.now() - (minOvenTimeMin + 1) * 60 * 1000);

		await WaxFillingRun.findByIdAndUpdate(lotId, {
			$set: {
				// Overriding by setting runEndTime to a point in the past that makes it appear ready
				runEndTime: forcedEntryTime,
				'adminOverride.reason': reason,
				'adminOverride.overriddenBy': locals.user._id,
				'adminOverride.overriddenAt': new Date()
			}
		});

		return { success: true };
	}
};
