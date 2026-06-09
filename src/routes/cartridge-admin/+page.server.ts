import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, AssayDefinition, User, WaxFillingRun, ReagentBatchRecord } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'cartridgeAdmin:read');
	await connectDB();

	// Parse filter/pagination params.
	// UI param names (`stage`, `assayType`, `operator`) come from the frozen
	// +page.svelte; older names (`lifecycleStage`, `assayTypeId`, `operatorId`)
	// are accepted as a fallback so deep-links from elsewhere still work.
	const search = url.searchParams.get('search') || '';
	const sortBy = url.searchParams.get('sortBy') || 'createdAt';
	const sortDir = (url.searchParams.get('sortDir') || 'desc') as 'asc' | 'desc';
	const assayTypeId =
		url.searchParams.get('assayType') || url.searchParams.get('assayTypeId') || '';
	const lifecycleStage =
		url.searchParams.get('stage') || url.searchParams.get('lifecycleStage') || '';
	const operatorId =
		url.searchParams.get('operator') || url.searchParams.get('operatorId') || '';
	// runId matches either the wax run or the reagent run for this cartridge —
	// whichever side it came from, the same input lets you pull every cart
	// linked to that run. Deep-linkable from the run-history expansion and
	// from the dashboard's recent-runs panel.
	const runId = url.searchParams.get('runId') || '';
	const pageNum = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
	// Operator-selectable page size. Whitelist to prevent arbitrary values from
	// loading huge result sets — fall back to 25 for anything outside the menu.
	const ALLOWED_PAGE_SIZES = [25, 50, 100, 200];
	const requestedPageSize = parseInt(url.searchParams.get('pageSize') || '25', 10);
	const pageSize = ALLOWED_PAGE_SIZES.includes(requestedPageSize) ? requestedPageSize : 25;

	// Build MongoDB query. Each multi-branch filter (search, operator, runId)
	// is its own $or; we AND them together via $and so they compose correctly
	// instead of clobbering one another into a single permissive $or.
	const query: any = {};
	const andClauses: any[] = [];
	if (search) {
		andClauses.push({
			$or: [
				{ _id: { $regex: search, $options: 'i' } },
				{ 'backing.lotQrCode': { $regex: search, $options: 'i' } },
				{ 'backing.lotId': { $regex: search, $options: 'i' } }
			]
		});
	}
	if (lifecycleStage) query.status = lifecycleStage;
	if (assayTypeId) query['reagentFilling.assayType._id'] = assayTypeId;
	if (operatorId) {
		andClauses.push({
			$or: [
				{ 'waxFilling.operator._id': operatorId },
				{ 'reagentFilling.operator._id': operatorId },
				{ 'backing.operator._id': operatorId }
			]
		});
	}
	if (runId) {
		andClauses.push({
			$or: [
				{ 'waxFilling.runId': runId },
				{ 'reagentFilling.runId': runId }
			]
		});
	}
	if (andClauses.length === 1) {
		Object.assign(query, andClauses[0]);
	} else if (andClauses.length > 1) {
		query.$and = andClauses;
	}

	// Sort mapping. Keys match the `key` values used by the frozen UI's column
	// headers (date_created, assay_type, current_status, operator) plus the
	// camelCase legacy keys for backward compatibility.
	const sortMap: Record<string, string> = {
		date_created: 'createdAt',
		createdAt: 'createdAt',
		current_status: 'status',
		currentLifecycleStage: 'status',
		assay_type: 'reagentFilling.assayType.name',
		operator: 'waxFilling.operator.username',
		cartridgeId: '_id'
	};
	const sortField = sortMap[sortBy] || 'createdAt';

	const [cartridges, total, assayTypes, operators, waxRuns, reagentRuns] = await Promise.all([
		CartridgeRecord.find(query)
			.sort({ [sortField]: sortDir === 'asc' ? 1 : -1 })
			.skip((pageNum - 1) * pageSize)
			.limit(pageSize)
			.lean(),
		CartridgeRecord.countDocuments(query),
		AssayDefinition.find().select('_id name').sort({ name: 1 }).lean(),
		User.find({ isActive: true }).select('_id username').sort({ username: 1 }).lean(),
		// Recent runs feed the run-filter dropdown. Pull the most recent 100 of
		// each side, then merge + trim to 100 overall after sorting by start time.
		WaxFillingRun.find()
			.select('_id operator runStartTime createdAt')
			.sort({ createdAt: -1 })
			.limit(100)
			.lean(),
		ReagentBatchRecord.find()
			.select('_id operator runStartTime createdAt')
			.sort({ createdAt: -1 })
			.limit(100)
			.lean()
	]);

	const recentRuns = [
		...(waxRuns as any[]).map(r => ({
			id: r._id,
			processType: 'wax' as const,
			operator: r.operator?.username ?? null,
			startedAt: (r.runStartTime ?? r.createdAt) as Date | null
		})),
		...(reagentRuns as any[]).map(r => ({
			id: r._id,
			processType: 'reagent' as const,
			operator: r.operator?.username ?? null,
			startedAt: (r.runStartTime ?? r.createdAt) as Date | null
		}))
	]
		.sort((a, b) => {
			const at = a.startedAt ? new Date(a.startedAt).getTime() : 0;
			const bt = b.startedAt ? new Date(b.startedAt).getTime() : 0;
			return bt - at;
		})
		.slice(0, 100);

	// When the runId filter is active, pull the run-level notes block from
	// whichever run doc the id belongs to (wax or reagent). Header above the
	// cartridge table renders this so operators see the run note alongside
	// the carts in that run without having to open any individual cart.
	let activeRunNotes: { id: string; body: string; phase: string; author: string | null; createdAt: string | null }[] = [];
	let activeRunMeta: { runId: string; processType: 'wax' | 'reagent'; status: string | null } | null = null;
	if (runId) {
		const [waxRun, reagentRun] = await Promise.all([
			WaxFillingRun.findById(runId).select('notes status').lean().catch(() => null),
			ReagentBatchRecord.findById(runId).select('notes status').lean().catch(() => null)
		]);
		const found = (waxRun ?? reagentRun) as any;
		const processType: 'wax' | 'reagent' | null = waxRun ? 'wax' : (reagentRun ? 'reagent' : null);
		if (found && processType) {
			activeRunMeta = { runId, processType, status: found.status ?? null };
			activeRunNotes = ((found.notes ?? []) as any[])
				.slice()
				.sort((a: any, b: any) =>
					new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()
				)
				.map((n: any) => ({
					id: String(n._id ?? ''),
					body: n.body ?? '',
					phase: n.phase ?? '',
					author: n.author?.username ?? null,
					createdAt: n.createdAt ? new Date(n.createdAt).toISOString() : null
				}));
		}
	}

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
		recentRuns: recentRuns.map(r => ({
			id: r.id,
			processType: r.processType,
			operator: r.operator,
			startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null
		})),
		activeRunMeta,
		activeRunNotes,
		total,
		pageSize,
		pageNum
	};
};

export const config = { maxDuration: 60 };
