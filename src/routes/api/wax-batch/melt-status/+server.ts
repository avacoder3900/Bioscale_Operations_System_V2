import { json, error } from '@sveltejs/kit';
import { connectDB, ReceivingLot } from '$lib/server/db';
import type { RequestHandler } from './$types';

const WAX_TUBE_PART_NUMBER = 'PT-CT-114';

type MeltState = 'cold' | 'melting' | 'ready';

/**
 * Daily melt-status board: every active wax tube ReceivingLot with its
 * current melt state. Powers the "take out wax to begin melting" indicator
 * on manufacturing dashboards.
 *
 *   cold    — waxMelt not started and no confirmed melt
 *   melting — startedAt set, readyAt still in the future, no confirmation
 *   ready   — confirmedMeltedAt set OR readyAt <= now
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const lots = await ReceivingLot.find({
		'part.partNumber': WAX_TUBE_PART_NUMBER,
		status: { $in: ['accepted', 'in_progress'] }
	})
		.select('_id lotId lotNumber quantity consumedUl waxMelt')
		.sort({ createdAt: -1 })
		.lean() as any[];

	const now = Date.now();
	const items = lots.map((lot) => {
		const melt = lot.waxMelt;
		const readyAtMs = melt?.readyAt ? new Date(melt.readyAt).getTime() : null;
		const confirmed = !!melt?.confirmedMeltedAt;
		const timerReady = readyAtMs !== null && readyAtMs <= now;

		let meltState: MeltState = 'cold';
		if (confirmed || timerReady) meltState = 'ready';
		else if (melt?.startedAt) meltState = 'melting';

		const remainingMin = readyAtMs !== null && !timerReady && !confirmed
			? Math.max(0, Math.ceil((readyAtMs - now) / 60_000))
			: 0;

		return {
			lotId: String(lot._id),
			lotNumber: lot.lotNumber ?? lot.lotId,
			lotBarcode: lot.lotId,
			meltState,
			remainingMin,
			startedAt: melt?.startedAt ? new Date(melt.startedAt).toISOString() : null,
			readyAt: melt?.readyAt ? new Date(melt.readyAt).toISOString() : null,
			confirmedMeltedAt: melt?.confirmedMeltedAt ? new Date(melt.confirmedMeltedAt).toISOString() : null,
			quantity: lot.quantity ?? 0
		};
	});

	const counts = {
		cold: items.filter((i) => i.meltState === 'cold').length,
		melting: items.filter((i) => i.meltState === 'melting').length,
		ready: items.filter((i) => i.meltState === 'ready').length
	};

	return json({
		success: true,
		items,
		counts,
		needsAttention: counts.ready === 0 && counts.cold > 0
	});
};
