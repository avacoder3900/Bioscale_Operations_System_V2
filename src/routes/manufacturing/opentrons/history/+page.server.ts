import { redirect } from '@sveltejs/kit';
import {
	connectDB, WaxFillingRun, ReagentBatchRecord, Equipment, AssayDefinition
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 20;

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	// Parse filter params
	const pageNum = Math.max(1, Number(url.searchParams.get('page') ?? 1));
	const processType = url.searchParams.get('processType') as 'wax' | 'reagent' | null;
	const robotId = url.searchParams.get('robotId') || undefined;
	const operatorId = url.searchParams.get('operatorId') || undefined;
	const status = url.searchParams.get('status') || undefined;
	const assayTypeId = url.searchParams.get('assayTypeId') || undefined;
	const search = url.searchParams.get('search') || undefined;
	const sortBy = url.searchParams.get('sortBy') || 'createdAt';
	const sortDir = (url.searchParams.get('sortDir') === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';

	// Helper: build sort object
	const sortOrder = sortDir === 'asc' ? 1 : -1;
	const sortField = sortBy === 'startTime' ? 'runStartTime'
		: sortBy === 'totalCartridges' ? 'cartridgeCount'
			: sortBy === 'successRate' ? 'cartridgeCount'
				: sortBy === 'operatorName' ? 'operator.username'
					: sortBy === 'robotId' ? 'robot._id'
						: sortBy === 'assayTypeName' ? 'assayType.name'
							: 'createdAt';

	const waxQuery: Record<string, any> = {};
	const reagentQuery: Record<string, any> = {};

	if (robotId) {
		waxQuery['robot._id'] = robotId;
		reagentQuery['robot._id'] = robotId;
	}
	if (operatorId) {
		waxQuery['operator._id'] = operatorId;
		reagentQuery['operator._id'] = operatorId;
	}
	if (status) {
		// Normalize status for case-insensitive matching
		const statuses = [status, status.toLowerCase(), status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()];
		waxQuery['status'] = { $in: statuses };
		reagentQuery['status'] = { $in: statuses };
	}
	if (assayTypeId) {
		reagentQuery['assayType._id'] = assayTypeId;
	}
	if (search) {
		const searchRegex = { $regex: search, $options: 'i' };
		waxQuery['_id'] = searchRegex;
		reagentQuery['_id'] = searchRegex;
	}

	// Fetch both wax and reagent runs
	const skip = (pageNum - 1) * PAGE_SIZE;
	const sort = { [sortField]: sortOrder } as Record<string, 1 | -1>;

	type RunRow = {
		runId: string; processType: 'wax' | 'reagent'; robotId: string;
		operatorId: string; operatorName: string | null;
		assayTypeId: string | null; assayTypeName: string | null;
		status: string; totalCartridges: number;
		acceptedCartridges: number; rejectedCartridges: number;
		startTime: string | null; endTime: string | null;
		createdAt: string; abortReason: string | null;
	};

	let runs: RunRow[] = [];
	let total = 0;

	if (processType === 'wax' || !processType) {
		const [waxRuns, waxTotal] = await Promise.all([
			WaxFillingRun.find(waxQuery).sort(sort).skip(skip).limit(PAGE_SIZE).lean(),
			WaxFillingRun.countDocuments(waxQuery)
		]);

		const waxRows: RunRow[] = (waxRuns as any[]).map((r) => ({
			runId: String(r._id),
			processType: 'wax',
			robotId: r.robot?._id ? String(r.robot._id) : '',
			operatorId: r.operator?._id ? String(r.operator._id) : '',
			operatorName: r.operator?.username ?? null,
			assayTypeId: null,
			assayTypeName: null,
			status: r.status ?? 'unknown',
			totalCartridges: r.cartridgeIds?.length ?? r.plannedCartridgeCount ?? 0,
			acceptedCartridges: 0,
			rejectedCartridges: 0,
			startTime: r.runStartTime ? new Date(r.runStartTime).toISOString() : null,
			endTime: r.runEndTime ? new Date(r.runEndTime).toISOString() : null,
			createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : '',
			abortReason: r.abortReason ?? null
		}));

		if (processType === 'wax') {
			runs = waxRows;
			total = waxTotal;
		} else {
			runs.push(...waxRows);
			total += waxTotal;
		}
	}

	if (processType === 'reagent' || !processType) {
		const [reagentRuns, reagentTotal] = await Promise.all([
			ReagentBatchRecord.find(reagentQuery).sort(sort).skip(skip).limit(PAGE_SIZE).lean(),
			ReagentBatchRecord.countDocuments(reagentQuery)
		]);

		const reagentRows: RunRow[] = (reagentRuns as any[]).map((r) => {
			const carts = r.cartridgesFilled ?? [];
			const accepted = carts.filter((c: any) => c.inspectionStatus === 'Accepted').length;
			const rejected = carts.filter((c: any) => c.inspectionStatus === 'Rejected').length;

			return {
				runId: String(r._id),
				processType: 'reagent',
				robotId: r.robot?._id ? String(r.robot._id) : '',
				operatorId: r.operator?._id ? String(r.operator._id) : '',
				operatorName: r.operator?.username ?? null,
				assayTypeId: r.assayType?._id ? String(r.assayType._id) : null,
				assayTypeName: r.assayType?.name ?? null,
				status: r.status ?? 'unknown',
				totalCartridges: r.cartridgeCount ?? carts.length,
				acceptedCartridges: accepted,
				rejectedCartridges: rejected,
				startTime: r.runStartTime ? new Date(r.runStartTime).toISOString() : null,
				endTime: r.runEndTime ? new Date(r.runEndTime).toISOString() : null,
				createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : '',
				abortReason: r.abortReason ?? null
			};
		});

		if (processType === 'reagent') {
			runs = reagentRows;
			total = reagentTotal;
		} else {
			runs.push(...reagentRows);
			total += reagentTotal;
		}
	}

	// Sort combined results when both types are included
	if (!processType) {
		runs.sort((a, b) => {
			const aVal = a.createdAt;
			const bVal = b.createdAt;
			return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
		});
		// Apply pagination on combined set
		runs = runs.slice(0, PAGE_SIZE);
	}

	// Summary stats
	const isCompleted = (s: string) => ['completed', 'Completed'].includes(s);
	const isAborted = (s: string) => ['aborted', 'Aborted', 'voided', 'cancelled', 'Cancelled'].includes(s);

	const completedRuns = runs.filter((r) => isCompleted(r.status)).length;
	const abortedRuns = runs.filter((r) => isAborted(r.status)).length;
	const runsWithDuration = runs.filter((r) => r.startTime && r.endTime);
	const avgDurationMinutes = runsWithDuration.length > 0
		? Math.round(
			runsWithDuration.reduce((sum, r) => {
				const ms = new Date(r.endTime!).getTime() - new Date(r.startTime!).getTime();
				return sum + ms / 60000;
			}, 0) / runsWithDuration.length
		)
		: 0;
	const totalCartridges = runs.reduce((sum, r) => sum + r.totalCartridges, 0);
	const totalAccepted = runs.reduce((sum, r) => sum + r.acceptedCartridges, 0);
	const successRate = totalCartridges > 0 ? totalAccepted / totalCartridges : 0;

	// Fetch filter option lists
	const [robots, assayTypes] = await Promise.all([
		Equipment.find({ equipmentType: 'robot', isActive: true }, { _id: 1, name: 1 }).lean(),
		AssayDefinition.find({ isActive: true }, { _id: 1, name: 1 }).lean()
	]);

	// Build unique operators from current run set
	const operatorMap = new Map<string, string>();
	for (const r of runs) {
		if (r.operatorId && r.operatorName) operatorMap.set(r.operatorId, r.operatorName);
	}
	const operators = [...operatorMap.entries()].map(([id, name]) => ({ id, name }));

	return {
		runs,
		total,
		summary: {
			totalRuns: total,
			completedRuns,
			abortedRuns,
			successRate,
			avgDurationMinutes,
			totalCartridges
		},
		pageNum,
		pageSize: PAGE_SIZE,
		robots: (robots as any[]).map((r) => ({ robotId: String(r._id), name: r.name ?? '' })),
		operators,
		assayTypes: (assayTypes as any[]).map((a) => ({ id: String(a._id), name: a.name ?? '' })),
		filters: {
			processType: processType ?? undefined,
			robotId,
			operatorId,
			status,
			assayTypeId,
			search,
			sortBy,
			sortDir
		}
	};
};

export const config = { maxDuration: 60 };
