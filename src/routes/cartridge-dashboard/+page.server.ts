import { redirect } from '@sveltejs/kit';
import { connectDB, CartridgeRecord, LabCartridge, CartridgeGroup, EquipmentLocation } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const now = new Date();
	const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
	const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

	const [
		phaseCounts,
		totalMfg,
		totalVoided,
		waxQcCounts,
		reagentInspCounts,
		recentCartridges,
		expiringCartridges,
		fridges,
		weeklyProduction,
		assayBreakdown,
		labStatusCounts,
		labTypeCounts,
		labGroups,
		labTotal
	] = await Promise.all([
		// Manufacturing pipeline phase counts
		CartridgeRecord.aggregate([
			{ $match: { currentPhase: { $ne: null } } },
			{ $group: { _id: '$currentPhase', count: { $sum: 1 } } },
			{ $sort: { count: -1 } }
		]),
		CartridgeRecord.countDocuments({ currentPhase: { $ne: 'voided' } }),
		CartridgeRecord.countDocuments({ currentPhase: 'voided' }),
		// Wax QC pass/fail
		CartridgeRecord.aggregate([
			{ $match: { 'waxQc.status': { $exists: true } } },
			{ $group: { _id: '$waxQc.status', count: { $sum: 1 } } }
		]),
		// Reagent inspection pass/fail
		CartridgeRecord.aggregate([
			{ $match: { 'reagentInspection.status': { $exists: true } } },
			{ $group: { _id: '$reagentInspection.status', count: { $sum: 1 } } }
		]),
		// Recent activity (last 20 updated)
		CartridgeRecord.find()
			.sort({ updatedAt: -1 })
			.limit(15)
			.lean(),
		// Expiring within 30 days (reagent fill expiration)
		CartridgeRecord.find({
			'reagentFilling.expirationDate': { $lte: thirtyDaysFromNow, $gte: now },
			currentPhase: { $nin: ['voided', 'completed', 'shipped'] }
		}).sort({ 'reagentFilling.expirationDate': 1 }).limit(10).lean(),
		// Fridge storage locations
		EquipmentLocation.find({ locationType: 'fridge', isActive: true }).lean().catch(() => []),
		// Weekly production (created in last 7 days)
		CartridgeRecord.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
		// Assay type breakdown
		CartridgeRecord.aggregate([
			{ $match: { 'reagentFilling.assayType.name': { $exists: true } } },
			{ $group: { _id: '$reagentFilling.assayType.name', count: { $sum: 1 } } },
			{ $sort: { count: -1 } }
		]),
		// Lab cartridges (existing)
		LabCartridge.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
		LabCartridge.aggregate([{ $group: { _id: '$cartridgeType', count: { $sum: 1 } } }]),
		CartridgeGroup.find().lean(),
		LabCartridge.countDocuments()
	]);

	// Storage distribution (how many cartridges per fridge)
	const storageCounts = await CartridgeRecord.aggregate([
		{ $match: { 'storage.locationId': { $exists: true }, currentPhase: { $in: ['stored', 'wax_stored'] } } },
		{ $group: { _id: '$storage.locationId', count: { $sum: 1 } } }
	]);
	const fridgeMap = new Map((fridges as any[]).map((f: any) => [String(f._id), f.displayName ?? f.barcode ?? String(f._id)]));

	// Phase pipeline order for display
	const phaseOrder = ['backing', 'wax_filled', 'wax_qc', 'wax_stored', 'reagent_filled', 'inspected', 'sealed', 'cured', 'stored', 'released', 'shipped', 'assay_loaded', 'testing', 'completed'];
	const phaseMap = new Map((phaseCounts as any[]).map((p: any) => [p._id, p.count]));

	const qcMap = (arr: any[]) => {
		const m: Record<string, number> = {};
		for (const item of arr) m[item._id] = item.count;
		return m;
	};

	// Lab group counts
	const labGroupCounts = await LabCartridge.aggregate([
		{ $match: { groupId: { $ne: null } } },
		{ $group: { _id: '$groupId', count: { $sum: 1 } } }
	]);
	const labGroupMap = new Map((labGroups as any[]).map((g: any) => [g._id, g]));

	return {
		// Manufacturing pipeline
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
		// Lab cartridges
		lab: {
			total: labTotal,
			statusCounts: (labStatusCounts as any[]).map((s: any) => ({ status: s._id, count: s.count })),
			typeCounts: (labTypeCounts as any[]).map((t: any) => ({ type: t._id, count: t.count })),
			groupSummary: (labGroupCounts as any[]).map((g: any) => {
				const group = labGroupMap.get(g._id) as any;
				return { groupName: group?.name ?? 'Unknown', color: group?.color, count: g.count };
			})
		}
	};
};
