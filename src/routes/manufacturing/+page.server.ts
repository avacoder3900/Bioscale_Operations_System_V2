import { redirect } from '@sveltejs/kit';
import { connectDB, LotRecord } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

	const [recentLots, todayLots] = await Promise.all([
		LotRecord.find().sort({ createdAt: -1 }).limit(10).lean(),
		LotRecord.find({ createdAt: { $gte: todayStart } }).lean()
	]);

	// Build stats keyed by configId: { lotsToday, unitsToday }
	const stats: Record<string, { lotsToday: number; unitsToday: number }> = {};
	for (const lot of todayLots as any[]) {
		const configId = lot.processConfig?._id;
		if (!configId) continue;
		if (!stats[configId]) stats[configId] = { lotsToday: 0, unitsToday: 0 };
		stats[configId].lotsToday++;
		stats[configId].unitsToday += lot.quantityProduced ?? 0;
	}

	return {
		recentLots: recentLots.map((l: any) => ({
			lotId: l._id,
			qrCodeRef: l.qrCodeRef,
			configId: l.processConfig?._id ?? '',
			quantityProduced: l.quantityProduced ?? 0,
			startTime: l.startTime ?? null,
			finishTime: l.finishTime ?? null,
			cycleTime: l.cycleTime ?? null,
			status: l.status ?? 'unknown',
			username: l.operator?.username ?? null
		})),
		stats
	};
};

export const config = { maxDuration: 60 };
