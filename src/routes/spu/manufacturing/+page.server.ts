import { redirect } from '@sveltejs/kit';
import { connectDB, LotRecord, WaxFillingRun, ReagentBatchRecord, CartridgeRecord } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const [recentLots, activeWaxRuns, activeReagentRuns, phaseDistribution] = await Promise.all([
		LotRecord.find().sort({ createdAt: -1 }).limit(10).lean(),
		WaxFillingRun.find({ status: { $in: ['setup', 'running'] } }).sort({ createdAt: -1 }).lean(),
		ReagentBatchRecord.find({ status: { $in: ['setup', 'running'] } }).sort({ createdAt: -1 }).lean(),
		CartridgeRecord.aggregate([
			{ $group: { _id: '$currentPhase', count: { $sum: 1 } } }
		])
	]);

	return {
		recentLots: recentLots.map((l: any) => ({
			id: l._id,
			qrCodeRef: l.qrCodeRef,
			processName: l.processConfig?.processName ?? null,
			processType: l.processConfig?.processType ?? null,
			status: l.status ?? null,
			operatorUsername: l.operator?.username ?? null,
			quantityProduced: l.quantityProduced ?? null,
			startTime: l.startTime ?? null,
			finishTime: l.finishTime ?? null,
			createdAt: l.createdAt
		})),
		activeWaxRuns: activeWaxRuns.map((r: any) => ({
			id: r._id,
			robotName: r.robot?.name ?? null,
			status: r.status,
			cartridgeCount: r.cartridgeIds?.length ?? 0,
			startTime: r.runStartTime ?? null,
			operatorUsername: r.operator?.username ?? null
		})),
		activeReagentRuns: activeReagentRuns.map((r: any) => ({
			id: r._id,
			robotName: r.robot?.name ?? null,
			status: r.status,
			assayTypeName: r.assayType?.name ?? null,
			cartridgeCount: r.cartridgeCount ?? 0,
			startTime: r.runStartTime ?? null,
			operatorUsername: r.operator?.username ?? null
		})),
		phaseDistribution: phaseDistribution.map((p: any) => ({
			phase: p._id,
			count: p.count
		}))
	};
};
