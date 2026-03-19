import { connectDB, ProductionRun, WorkInstruction, User } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	await connectDB();
	const runs = await ProductionRun.find().sort({ createdAt: -1 }).limit(100).lean();

	const wiIds = [...new Set(runs.map((r: any) => r.workInstructionId).filter(Boolean))];
	const wis = wiIds.length > 0
		? await WorkInstruction.find({ _id: { $in: wiIds } }).select('_id title').lean()
		: [];
	const wiMap = new Map(wis.map((w: any) => [w._id, w.title]));

	const builderIds = [...new Set(runs.map((r: any) => r.leadBuilder?._id).filter(Boolean))];
	const builders = builderIds.length > 0
		? await User.find({ _id: { $in: builderIds } }).select('_id username').lean()
		: [];
	const builderMap = new Map(builders.map((u: any) => [u._id, u.username]));

	return {
		buildLogs: runs.map((r: any) => ({
			id: r._id,
			runNumber: r.runNumber ?? '',
			workInstructionTitle: r.workInstructionId ? (wiMap.get(r.workInstructionId) ?? 'Unknown') : 'Unknown',
			status: r.status ?? 'planning',
			startedAt: r.startedAt ?? r.createdAt,
			completedAt: r.completedAt ?? null,
			operatorName: r.leadBuilder?._id ? (builderMap.get(r.leadBuilder._id) ?? r.leadBuilder?.username ?? 'Unknown') : 'Unknown'
		}))
	};
};

export const config = { maxDuration: 60 };
