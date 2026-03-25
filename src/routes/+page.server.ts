export const config = { maxDuration: 60 };
import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB, Spu, Batch, BomItem, ProductionRun, Customer, User, AuditLog, generateId,
	LabCartridge, CartridgeGroup, CartridgeRecord, Equipment, EquipmentLocation,
	OpentronsRobot, WaxFillingRun, AssayDefinition
} from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const stateFilter = url.searchParams.get('state');

	const spuQuery: Record<string, any> = {};
	if (stateFilter) spuQuery.status = stateFilter;

	const [spus, batches, bomItems, activeRuns, customers] = await Promise.all([
		Spu.find(spuQuery).sort({ createdAt: -1 }).lean(),
		Batch.find().sort({ batchNumber: 1 }).lean(),
		BomItem.find({ isActive: true }).lean(),
		ProductionRun.find({ status: { $in: ['planning', 'in_progress', 'paused'] } }).lean(),
		Customer.find({ status: 'active' }).lean()
	]);

	// Build user lookup for createdBy
	const userIds = [...new Set(spus.map((s: any) => s.createdBy).filter(Boolean))];
	const users = userIds.length ? await User.find({ _id: { $in: userIds } }, { username: 1 }).lean() : [];
	const userMap = new Map(users.map((u: any) => [u._id, u.username]));

	// State counts
	const stateCounts: Record<string, number> = {};
	const allSpus = stateFilter ? await Spu.find({}, { status: 1 }).lean() : spus;
	for (const s of allSpus) {
		const st = (s as any).status || 'draft';
		stateCounts[st] = (stateCounts[st] || 0) + 1;
	}

	// BOM summary
	const activeItems = bomItems.filter((b: any) => b.isActive);
	const totalCost = activeItems.reduce((sum: number, b: any) => sum + (Number(b.unitCost) || 0), 0);
	const now = new Date();
	const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
	const expiringItems = activeItems.filter(
		(b: any) => b.expirationDate && new Date(b.expirationDate) <= thirtyDays
	);

	return {
		spus: spus.map((s: any) => ({
			id: s._id,
			udi: s.udi,
			barcode: s.barcode ?? null,
			status: s.status ?? 'draft',
			deviceState: s.deviceState ?? '',
			owner: s.owner ?? null,
			ownerNotes: s.ownerNotes ?? null,
			batchId: s.batch?._id ?? null,
			batchNumber: s.batch?.batchNumber ?? null,
			createdAt: s.createdAt,
			createdByUsername: userMap.get(s.createdBy) ?? null,
			assignmentType: s.assignment?.type ?? null,
			assignmentCustomerId: s.assignment?.customer?._id ?? null,
			customerName: s.assignment?.customer?.name ?? null,
			qcStatus: s.qcStatus ?? 'pending',
			qcDocumentUrl: s.qcDocumentUrl ?? null,
			assemblyStatus: s.assemblyStatus ?? 'created'
		})),
		batches: batches.map((b: any) => ({ id: b._id, batchNumber: b.batchNumber ?? '' })),
		bomSummary: {
			totalItems: bomItems.length,
			activeItems: activeItems.length,
			totalCost: totalCost.toFixed(2),
			expiringWithin30Days: expiringItems.length,
			lastSyncAt: null,
			lastSyncStatus: null,
			lastSyncError: null
		},
		expiringItems: expiringItems.map((b: any) => ({
			partNumber: b.partNumber ?? '',
			name: b.name ?? '',
			expirationDate: b.expirationDate
		})),
		syncErrorDetail: null as { message: string; code?: string } | null,
		costBreakdown: null as {
			materialSubtotal: number;
			laborSubtotal: number;
			lineItems: { partName: string; materialCost: number; laborCost: number }[];
		} | null,
		activeRuns: activeRuns.map((r: any) => ({
			id: r._id,
			runNumber: r.runNumber ?? '',
			status: r.status,
			quantity: r.quantity ?? 0,
			workInstructionId: r.workInstructionId ?? '',
			workInstructionTitle: '',
			completedUnits: (r.units ?? []).filter((u: any) => u.status === 'completed').length
		})),
		stateCounts,
		stateFilter,
		fieldHints: { batchRecommended: true, ownerRecommended: false },
		fleetSummary: (() => {
			const spuList = spus.map((s: any) => ({
				id: s._id, udi: s.udi, status: s.status ?? 'draft',
				deviceState: s.deviceState ?? '', owner: s.owner ?? null,
				ownerNotes: s.ownerNotes ?? null, batchId: s.batch?._id ?? null,
				createdAt: s.createdAt ?? null, updatedAt: s.updatedAt ?? null,
				finalizedAt: s.finalizedAt ?? null, qcStatus: s.qcStatus ?? 'pending',
				qcDocumentUrl: s.qcDocumentUrl ?? null, assemblyStatus: s.assemblyStatus ?? 'created',
				assignmentType: s.assignment?.type ?? null,
				assignmentCustomerId: s.assignment?.customer?._id ?? null
			}));
			const rnd = spuList.filter((s) => s.assignmentType === 'rnd');
			const manufacturing = spuList.filter((s) => s.assignmentType === 'manufacturing');
			const unassigned = spuList.filter((s) => !s.assignmentType);
			const customerGroups = customers
				.map((c: any) => ({
					customer: { id: c._id, name: c.name ?? '', customerType: c.customerType ?? '' },
					spus: spuList.filter((s) => s.assignmentCustomerId === c._id)
				}))
				.filter((g) => g.spus.length > 0);
			return { rnd, manufacturing, customers: customerGroups, unassigned };
		})(),
		activeCustomers: customers.map((c: any) => ({
			id: c._id,
			name: c.name ?? '',
			customerType: c.customerType ?? ''
		})),
		// Full Cartridge Dashboard data (manufacturing pipeline, QC, assay, storage, expiring)
		cartridgeDashboard: await (async () => {
			try {
				const cdNow = new Date();
				const sevenDaysAgo = new Date(cdNow.getTime() - 7 * 24 * 60 * 60 * 1000);
				const thirtyDaysFromNow = new Date(cdNow.getTime() + 30 * 24 * 60 * 60 * 1000);
				let storageCounts: any[] = [];

				const [
					phaseCounts, totalMfg, totalVoided, waxQcCounts, reagentInspCounts,
					recentCartridges, expiringCartridges, fridges, ovens, weeklyProduction,
					assayBreakdown, labStatusCounts, labTypeCounts, labGroups, labTotal
				] = await Promise.all([
					CartridgeRecord.aggregate([
						{ $match: { currentPhase: { $ne: null } } },
						{ $group: { _id: '$currentPhase', count: { $sum: 1 } } },
						{ $sort: { count: -1 } }
					]).catch(() => []),
					CartridgeRecord.countDocuments({ currentPhase: { $ne: 'voided' } }).catch(() => 0),
					CartridgeRecord.countDocuments({ currentPhase: 'voided' }).catch(() => 0),
					CartridgeRecord.aggregate([
						{ $match: { 'waxQc.status': { $exists: true } } },
						{ $group: { _id: '$waxQc.status', count: { $sum: 1 } } }
					]).catch(() => []),
					CartridgeRecord.aggregate([
						{ $match: { 'reagentInspection.status': { $exists: true } } },
						{ $group: { _id: '$reagentInspection.status', count: { $sum: 1 } } }
					]).catch(() => []),
					CartridgeRecord.find().sort({ updatedAt: -1 }).limit(15).lean().catch(() => []),
					CartridgeRecord.find({
						'reagentFilling.expirationDate': { $lte: thirtyDaysFromNow, $gte: cdNow },
						currentPhase: { $nin: ['voided', 'completed', 'shipped'] }
					}).sort({ 'reagentFilling.expirationDate': 1 }).limit(10).lean().catch(() => []),
					Equipment.find({ equipmentType: 'fridge', status: { $ne: 'offline' } }).lean().catch(() => []),
					Equipment.find({ equipmentType: 'oven', status: { $ne: 'offline' } }).lean().catch(() => []),
					CartridgeRecord.countDocuments({ createdAt: { $gte: sevenDaysAgo } }).catch(() => 0),
					CartridgeRecord.aggregate([
						{ $match: { 'reagentFilling.assayType.name': { $exists: true } } },
						{ $group: { _id: '$reagentFilling.assayType.name', count: { $sum: 1 } } },
						{ $sort: { count: -1 } }
					]).catch(() => []),
					LabCartridge.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).catch(() => []),
					LabCartridge.aggregate([{ $group: { _id: '$cartridgeType', count: { $sum: 1 } } }]).catch(() => []),
					CartridgeGroup.find().lean().catch(() => []),
					LabCartridge.countDocuments().catch(() => 0)
				]);

				storageCounts = await (async () => {
					const [waxCounts, reagentCounts] = await Promise.all([
						CartridgeRecord.aggregate([
							{ $match: { 'waxStorage.location': { $exists: true }, currentPhase: 'wax_stored' } },
							{ $group: { _id: '$waxStorage.location', count: { $sum: 1 } } }
						]),
						CartridgeRecord.aggregate([
							{ $match: { 'storage.fridgeName': { $exists: true }, currentPhase: 'stored' } },
							{ $group: { _id: '$storage.fridgeName', count: { $sum: 1 } } }
						])
					]);
					const merged = new Map<string, number>();
					for (const s of [...waxCounts as any[], ...reagentCounts as any[]]) {
						merged.set(s._id, (merged.get(s._id) ?? 0) + s.count);
					}
					return Array.from(merged.entries()).map(([k, v]) => ({ _id: k, count: v }));
				})();
				const fridgeMap = new Map((fridges as any[]).map((f: any) => [f.barcode ?? f.name ?? String(f._id), f.name ?? f.barcode ?? String(f._id)]));
				// Map from barcode/name key → actual _id for detail links
				const fridgeIdMap = new Map((fridges as any[]).map((f: any) => [f.barcode ?? f.name ?? String(f._id), String(f._id)]));

				const phaseOrder = ['backing', 'wax_filled', 'wax_qc', 'wax_stored', 'reagent_filled', 'inspected', 'sealed', 'cured', 'stored', 'released', 'shipped', 'assay_loaded', 'testing', 'completed'];
				const phaseMap = new Map((phaseCounts as any[]).map((p: any) => [p._id, p.count]));

				const qcMap = (arr: any[]) => {
					const m: Record<string, number> = {};
					for (const item of arr) m[item._id] = item.count;
					return m;
				};

				const labGroupCounts = await LabCartridge.aggregate([
					{ $match: { groupId: { $ne: null } } },
					{ $group: { _id: '$groupId', count: { $sum: 1 } } }
				]);
				const labGroupMap = new Map((labGroups as any[]).map((g: any) => [g._id, g]));

				// ── New dashboard queries (each wrapped to prevent one failure from killing all) ──
				let fridgeCapacityAgg: any[] = [], allRobots: any[] = [], activeWaxRuns: any[] = [];
				let allAssays: any[] = [], cartridgeBomItems: any[] = [], dailyThroughputAgg: any[] = [];
				let recentWaxRuns: any[] = [], consumableCountsAgg: any[] = [];
				try {
				[fridgeCapacityAgg, allRobots, activeWaxRuns, allAssays,
					cartridgeBomItems, dailyThroughputAgg, recentWaxRuns, consumableCountsAgg
				] = await Promise.all([
					CartridgeRecord.aggregate([
						{ $match: { currentPhase: 'wax_stored', 'waxStorage.location': { $exists: true } } },
						{ $group: { _id: '$waxStorage.location', count: { $sum: 1 } } }
					]),
					OpentronsRobot.find({ isActive: true }).select('name lastHealthOk').sort({ name: 1 }).lean(),
					WaxFillingRun.find({ status: { $in: ['running', 'setup'] } }).select('robot status').lean(),
					AssayDefinition.find({ isActive: true }).select('name skuCode').lean(),
					BomItem.find({ isActive: true, partNumber: { $regex: /^CRT-/ } }).select('partNumber name unitCost').lean(),
					CartridgeRecord.aggregate([
						{ $match: { createdAt: { $gte: sevenDaysAgo } } },
						{ $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
						{ $sort: { _id: 1 } }
					]),
					WaxFillingRun.find().sort({ createdAt: -1 }).limit(5).lean(),
					Equipment.aggregate([
						{ $match: { equipmentType: { $in: ['deck', 'cooling_tray', 'robot'] } } },
						{ $group: { _id: '$equipmentType', count: { $sum: 1 } } }
					])
				]);
				} catch (enrichErr) {
					console.error('[DASHBOARD] enriched queries failed:', enrichErr instanceof Error ? enrichErr.message : enrichErr);
				}

				const assayFillCounts = await CartridgeRecord.aggregate([
					{ $match: { 'reagentFilling.assayType._id': { $exists: true } } },
					{ $group: { _id: '$reagentFilling.assayType._id', count: { $sum: 1 } } }
				]);
				const assayFillMap = new Map((assayFillCounts as any[]).map((a: any) => [a._id, a.count]));
				const busyRobotIds = new Set((activeWaxRuns as any[]).map((r: any) => r.robot?._id));
				const dayMap = new Map((dailyThroughputAgg as any[]).map((d: any) => [d._id, d.count]));
				const last7Days: { date: string; count: number }[] = [];
				for (let i = 6; i >= 0; i--) {
					const d = new Date(cdNow.getTime() - i * 86400000);
					const key = d.toISOString().slice(0, 10);
					last7Days.push({ date: key, count: dayMap.get(key) ?? 0 });
				}
				const crtCostTotal = (cartridgeBomItems as any[]).reduce((s: number, b: any) => s + (Number(b.unitCost) || 0), 0);

				return {
					pipeline: phaseOrder.map(phase => ({
						phase,
						count: phaseMap.get(phase) ?? 0,
						label: phase.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
					})),
					totalMfg,
					totalVoided,
					weeklyProduction,
					waxQc: qcMap(waxQcCounts as any[]),
					reagentInspection: qcMap(reagentInspCounts as any[]),
					assayBreakdown: (assayBreakdown as any[]).map((a: any) => ({ name: a._id, count: a.count })),
					storageDistribution: (storageCounts as any[]).map((s: any) => ({
						locationId: s._id,
						locationName: fridgeMap.get(s._id) ?? s._id,
						count: s.count
					})),
					expiringCount: expiringCartridges.length,
					expiringSoon: (expiringCartridges as any[]).map((c: any) => ({
						id: c._id,
						assay: c.reagentFilling?.assayType?.name ?? '—',
						expirationDate: c.reagentFilling?.expirationDate,
						phase: c.currentPhase
					})),
					recentActivity: (recentCartridges as any[]).map((c: any) => ({
						id: c._id,
						phase: c.currentPhase,
						assay: c.reagentFilling?.assayType?.name ?? null,
						waxQc: c.waxQc?.status ?? null,
						updatedAt: c.updatedAt
					})),
					lab: {
						total: labTotal,
						statusCounts: (labStatusCounts as any[]).map((s: any) => ({ status: s._id, count: s.count })),
						typeCounts: (labTypeCounts as any[]).map((t: any) => ({ type: t._id, count: t.count })),
						groupSummary: (labGroupCounts as any[]).map((g: any) => {
							const group = labGroupMap.get(g._id) as any;
							return { groupName: group?.name ?? 'Unknown', color: group?.color, count: g.count };
						})
					},
					fridgeCapacity: (fridges as any[]).map((f: any) => {
						const key = f.barcode ?? f.name ?? String(f._id);
						const agg = (fridgeCapacityAgg as any[]).find((a: any) => a._id === key || a._id === f.name || a._id === f.barcode);
						return {
							locationId: key,
							dbLocationId: String(f._id),
							locationName: f.name ?? f.barcode ?? String(f._id),
							used: agg?.count ?? 0,
							capacity: f.capacity ?? 10
						};
					}),
					ovenList: (ovens as any[]).map((o: any) => ({
						id: String(o._id),
						name: o.name ?? o.barcode ?? String(o._id),
						currentTemperatureC: o.currentTemperatureC ?? null,
						capacity: o.capacity ?? null
					})),
					robotStatus: (allRobots as any[]).map((r: any) => ({
						id: r._id,
						name: r.name,
						healthy: r.lastHealthOk ?? false,
						busy: busyRobotIds.has(r._id)
					})),
					assayInventory: (allAssays as any[]).map((a: any) => ({
						id: a._id,
						name: a.name,
						skuCode: a.skuCode,
						fillCount: assayFillMap.get(a._id) ?? 0
					})),
					dailyThroughput: last7Days,
					recentRuns: (recentWaxRuns as any[]).map((r: any) => ({
						id: r._id,
						status: r.status,
						robotName: r.robot?.name ?? '—',
						cartridgeCount: r.cartridgeIds?.length ?? r.plannedCartridgeCount ?? 0,
						date: r.createdAt
					})),
					bomCostPerCartridge: {
						total: crtCostTotal,
						items: (cartridgeBomItems as any[]).map((b: any) => ({
							partNumber: b.partNumber,
							name: b.name,
							unitCost: Number(b.unitCost) || 0
						}))
					},
					consumableStock: (consumableCountsAgg as any[]).map((c: any) => ({
						type: c._id,
						count: c.count
					}))
				};
			} catch (err) { 
				console.error('[DASHBOARD] cartridgeDashboard error:', err instanceof Error ? err.stack : err); 
				return null; 
			}
		})()
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const serialNumber = form.get('serialNumber')?.toString().trim();
		if (!serialNumber) return fail(400, { error: 'Serial number is required' });

		// Generate UDI from serial number
		const udi = `SPU-${serialNumber}`;
		const existing = await Spu.findOne({ udi });
		if (existing) return fail(400, { error: 'UDI already exists' });

		const batchId = form.get('batchId')?.toString() || undefined;
		let batchRef;
		if (batchId) {
			const batch = await Batch.findById(batchId).lean();
			if (batch) batchRef = { _id: (batch as any)._id, batchNumber: (batch as any).batchNumber };
		}

		const barcode = form.get('barcode')?.toString().trim() || undefined;
		await Spu.create({
			_id: generateId(),
			udi,
			barcode,
			status: 'draft',
			assemblyStatus: 'created',
			qcStatus: 'pending',
			batch: batchRef,
			createdBy: locals.user!._id
		});

		return { success: true };
	},

	register: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const udi = form.get('udi')?.toString().trim();
		if (!udi) return fail(400, { error: 'UDI is required' });

		const existing = await Spu.findOne({ udi });
		if (existing) return fail(400, { error: 'UDI already exists' });

		const batchId = form.get('batchId')?.toString() || undefined;
		let batchRef;
		if (batchId) {
			const batch = await Batch.findById(batchId).lean();
			if (batch) batchRef = { _id: (batch as any)._id, batchNumber: (batch as any).batchNumber };
		}

		const spuId = generateId();
		const barcode = form.get('barcode')?.toString().trim() || undefined;
		await Spu.create({
			_id: spuId,
			udi,
			barcode,
			status: 'draft',
			deviceState: form.get('deviceState')?.toString() || undefined,
			owner: form.get('owner')?.toString() || undefined,
			ownerNotes: form.get('ownerNotes')?.toString() || undefined,
			assemblyStatus: 'created',
			qcStatus: 'pending',
			batch: batchRef,
			createdBy: locals.user!._id
		});

		return { success: true, spuId };
	},

	updateState: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		const deviceState = form.get('deviceState')?.toString();
		if (!spuId || !deviceState) return fail(400, { error: 'SPU ID and state required' });

		const spu = await Spu.findById(spuId);
		if (!spu) return fail(400, { error: 'SPU not found' });
		if ((spu as any).finalizedAt) return fail(400, { error: 'SPU is finalized and cannot be modified' });

		const updates: Record<string, any> = { deviceState };
		if (form.get('owner')) updates.owner = form.get('owner')!.toString();
		if (form.get('ownerNotes')) updates.ownerNotes = form.get('ownerNotes')!.toString();

		await Spu.updateOne({ _id: spuId }, { $set: updates });
		return { success: true };
	},

	bulkUpdateState: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const spuIds = form.get('spuIds')?.toString().split(',').map((s) => s.trim()).filter(Boolean);
		const deviceState = form.get('deviceState')?.toString();
		if (!spuIds?.length || !deviceState) return fail(400, { error: 'SPU IDs and state required' });

		const result = await Spu.updateMany(
			{ _id: { $in: spuIds }, finalizedAt: null },
			{ $set: { deviceState } }
		);
		return { success: true, updatedCount: result.modifiedCount };
	},

	assignSpu: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		const assignmentType = form.get('assignmentType')?.toString();
		if (!spuId || !assignmentType) return fail(400, { assignError: 'SPU ID and type required' });

		const assignment: Record<string, any> = {
			type: assignmentType,
			assignedAt: new Date(),
			assignedBy: { _id: locals.user!._id, username: locals.user!.username }
		};

		if (assignmentType === 'customer') {
			const customerId = form.get('customerId')?.toString();
			if (customerId) {
				const customer = await Customer.findById(customerId).lean();
				if (customer) assignment.customer = { _id: (customer as any)._id, name: (customer as any).name };
			}
		}

		await Spu.updateOne({ _id: spuId }, { $set: { assignment, status: 'assigned' } });
		return { assignSuccess: true };
	},

	retrySync: async ({ locals }) => {
		requirePermission(locals.user, 'inventory:write');
		// Box sync would go here — placeholder
		return { syncSuccess: true, syncMessage: 'Sync not configured' };
	},

	updateStatus: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		const newStatus = form.get('status')?.toString();
		if (!spuId || !newStatus) return fail(400, { error: 'SPU ID and status required' });

		const validStatuses = ['draft', 'assembling', 'assembled', 'validating', 'validated', 'assigned', 'deployed', 'servicing', 'retired', 'voided'];
		if (!validStatuses.includes(newStatus)) return fail(400, { error: 'Invalid status' });

		const spu = await Spu.findById(spuId);
		if (!spu) return fail(404, { error: 'SPU not found' });
		if ((spu as any).finalizedAt) return fail(400, { error: 'SPU is finalized' });

		await Spu.updateOne({ _id: spuId }, { $set: { status: newStatus } });

		// Audit log
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: spuId,
			action: 'UPDATE',
			oldData: { status: (spu as any).status },
			newData: { status: newStatus },
			changedBy: locals.user!.username ?? locals.user!._id
		});

		return { statusUpdateSuccess: true, updatedStatus: newStatus };
	}
};

