import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, AssayDefinition, User } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'cartridgeAdmin:read');
	await connectDB();

	// Parse filter/pagination params
	const search = url.searchParams.get('search') || '';
	const sortBy = url.searchParams.get('sortBy') || 'createdAt';
	const sortDir = (url.searchParams.get('sortDir') || 'desc') as 'asc' | 'desc';
	const assayTypeId = url.searchParams.get('assayTypeId') || '';
	const lifecycleStage = url.searchParams.get('lifecycleStage') || '';
	const operatorId = url.searchParams.get('operatorId') || '';
	// runId matches either the wax run or the reagent run for this cartridge —
	// whichever side it came from, the same input lets you pull every cart
	// linked to that run. Deep-linkable from the run-history expansion and
	// from the dashboard's recent-runs panel.
	const runId = url.searchParams.get('runId') || '';
	const pageNum = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
	const pageSize = 25;

	// Build MongoDB query
	const query: any = {};
	if (search) {
		query.$or = [
			{ _id: { $regex: search, $options: 'i' } },
			{ 'backing.lotQrCode': { $regex: search, $options: 'i' } },
			{ 'backing.lotId': { $regex: search, $options: 'i' } }
		];
	}
	if (lifecycleStage) query.status = lifecycleStage;
	if (assayTypeId) query['reagentFilling.assayType._id'] = assayTypeId;
	if (operatorId) {
		query.$or = [
			...(query.$or ?? []),
			{ 'waxFilling.operator._id': operatorId },
			{ 'reagentFilling.operator._id': operatorId },
			{ 'backing.operator._id': operatorId }
		];
	}
	if (runId) {
		// Combine with any existing $or via $and so we don't clobber the search/operator branches
		const runIdOr = [
			{ 'waxFilling.runId': runId },
			{ 'reagentFilling.runId': runId }
		];
		if (query.$or) {
			query.$and = [{ $or: query.$or }, { $or: runIdOr }];
			delete query.$or;
		} else {
			query.$or = runIdOr;
		}
	}

	// Sort mapping
	const sortMap: Record<string, string> = {
		createdAt: 'createdAt',
		currentLifecycleStage: 'status',
		cartridgeId: '_id'
	};
	const sortField = sortMap[sortBy] || 'createdAt';

	const [cartridges, total, assayTypes, operators] = await Promise.all([
		CartridgeRecord.find(query)
			.sort({ [sortField]: sortDir === 'asc' ? 1 : -1 })
			.skip((pageNum - 1) * pageSize)
			.limit(pageSize)
			.lean(),
		CartridgeRecord.countDocuments(query),
		AssayDefinition.find().select('_id name').sort({ name: 1 }).lean(),
		User.find({ isActive: true }).select('_id username').sort({ username: 1 }).lean()
	]);

	return {
		filters: { search, sortBy, sortDir, assayTypeId, lifecycleStage, operatorId, runId },
		cartridges: (cartridges as any[]).map(c => {
			// Find first available operator name across phases
			const operatorName =
				c.waxFilling?.operator?.username ??
				c.reagentFilling?.operator?.username ??
				c.waxQc?.operator?.username ??
				null;

			return {
				cartridgeId: c._id,
				backedLotId: c.backing?.lotId ?? null,
				assayTypeName: c.reagentFilling?.assayType?.name ?? null,
				waxRunId: c.waxFilling?.runId ?? null,
				reagentRunId: c.reagentFilling?.runId ?? null,
				currentLifecycleStage: c.status ?? 'unknown',
				operatorName,
				createdAt: c.createdAt,
				expirationDate: c.reagentFilling?.expirationDate ?? null,
				storageLocation: c.storage?.fridgeName ?? c.storage?.locationId ?? null,
				waxStatus: c.waxFilling?.recordedAt ? 'completed' : (c.status === 'backing' ? 'pending' : null),
				waxQcStatus: c.waxQc?.status ?? null,
				inspectionStatus: c.reagentInspection?.status ?? null,
				topSealBatchId: c.topSeal?.batchId ?? null,
				coolingTrayId: c.waxStorage?.coolingTrayId ?? null,
				ovenEntryTime: c.backing?.ovenEntryTime ?? null,
				photoCount: (c.photos || []).length,
				// Most recent ~5 notes (newest first) so improper-order events
				// from the wax-flow guard show up in the row expansion.
				notes: ((c.notes ?? []) as any[])
					.slice()
					.sort((a: any, b: any) =>
						new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
					)
					.slice(0, 5)
					.map((n: any) => ({
						body: n.body ?? '',
						phase: n.phase ?? null,
						author: n.author?.username ?? null,
						createdAt: n.createdAt ?? null
					}))
			};
		}),
		assayTypes: (assayTypes as any[]).map(a => ({ id: a._id, name: a.name })),
		operators: (operators as any[]).map(u => ({ id: u._id, name: u.username })),
		total,
		pageSize,
		pageNum
	};
};

export const config = { maxDuration: 60 };
