import { redirect } from '@sveltejs/kit';
import { connectDB, CartridgeRecord, LabCartridge, CartridgeGroup, Equipment, BackingLot } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { getCheckedOutCartridgeIds } from '$lib/server/checkout-utils';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	// Exclude manually checked-out cartridges from active fridge/storage counts
	// (they're physically gone but keep their scrapped/accepted status).
	const checkedOutIds = await getCheckedOutCartridgeIds();

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
		ovens,
		weeklyProduction,
		assayBreakdown,
		labStatusCounts,
		labTypeCounts,
		labGroups,
		labTotal
	] = await Promise.all([
		// Manufacturing pipeline phase counts
		CartridgeRecord.aggregate([
			{ $match: { status: { $ne: null } } },
			{ $group: { _id: '$status', count: { $sum: 1 } } },
			{ $sort: { count: -1 } }
		]),
		CartridgeRecord.countDocuments({ status: { $ne: 'voided' } }),
		CartridgeRecord.countDocuments({ status: 'voided' }),
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
			status: { $nin: ['voided', 'completed', 'shipped'] }
		}).sort({ 'reagentFilling.expirationDate': 1 }).limit(10).lean(),
		// Fridge storage locations
		Equipment.find({ equipmentType: 'fridge', status: { $ne: 'offline' } }).lean().catch(() => []),
		// Oven/heater equipment
		Equipment.find({ equipmentType: 'oven', status: { $ne: 'offline' } }).lean().catch(() => []),
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

	// Storage distribution — merge wax storage (waxStorage.location) and reagent storage (storage.fridgeName)
	// Both fields store the fridge barcode string, not the equipment _id.
	// Oven occupancy reads from BackingLot: during backing phase cartridges
	// only exist as an aggregate count on the lot — individual CartridgeRecords
	// don't come into being until their UUID is scanned at wax deck loading.
	const [waxStorageCounts, reagentStorageCounts, ovenOccupancyAgg] = await Promise.all([
		CartridgeRecord.aggregate([
			{ $match: { 'waxStorage.location': { $exists: true }, status: 'wax_stored', _id: { $nin: checkedOutIds } } },
			{ $group: { _id: '$waxStorage.location', count: { $sum: 1 } } }
		]),
		CartridgeRecord.aggregate([
			{ $match: { 'storage.fridgeName': { $exists: true }, status: { $in: ['stored', 'reagent_filled'] }, _id: { $nin: checkedOutIds } } },
			{ $group: { _id: '$storage.fridgeName', count: { $sum: 1 } } }
		]),
		BackingLot.aggregate([
			{ $match: { status: { $in: ['in_oven', 'ready'] }, ovenLocationId: { $exists: true, $ne: null } } },
			{ $group: { _id: '$ovenLocationId', count: { $sum: '$cartridgeCount' } } }
		]).catch(() => [])
	]);
	const ovenOccupantMap = new Map<string, number>(
		(ovenOccupancyAgg as any[]).map((o: any) => [String(o._id), o.count])
	);
	const mergedCounts = new Map<string, number>();
	for (const s of [...waxStorageCounts as any[], ...reagentStorageCounts as any[]]) {
		mergedCounts.set(s._id, (mergedCounts.get(s._id) ?? 0) + s.count);
	}
	const storageCounts = Array.from(mergedCounts.entries()).map(([k, v]) => ({ _id: k, count: v }));

	// fridgeMap: keyed by barcode AND name so we can resolve any stored string back to a display name
	const fridgeMap = new Map<string, string>();
	const fridgeIdMap = new Map<string, string>(); // barcode/name → _id for detail links
	for (const f of fridges as any[]) {
		const label = f.name ?? f.barcode ?? String(f._id);
		if (f.barcode) { fridgeMap.set(f.barcode, label); fridgeIdMap.set(f.barcode, String(f._id)); }
		if (f.name) { fridgeMap.set(f.name, label); fridgeIdMap.set(f.name, String(f._id)); }
	}

	// Phase pipeline order for display. 'backing' isn't a CartridgeRecord status
	// anymore (cartridges don't exist as individuals during backing) — take that
	// count from BackingLot.cartridgeCount aggregated across in_oven + ready lots.
	const phaseOrder = ['backing', 'wax_filled', 'wax_qc', 'wax_stored', 'reagent_filled', 'inspected', 'sealed', 'cured', 'stored', 'released', 'shipped', 'linked', 'underway', 'completed'];
	const phaseMap = new Map((phaseCounts as any[]).map((p: any) => [p._id, p.count]));
	const backingPipelineCount = (ovenOccupancyAgg as any[]).reduce((s, o: any) => s + (o.count ?? 0), 0);
	phaseMap.set('backing', backingPipelineCount);

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
		storageDistribution: (fridges as any[]).map((f: any) => {
			const label = f.name ?? f.barcode ?? String(f._id);
			const key = f.barcode ?? f.name ?? String(f._id);
			return {
				locationId: String(f._id),
				locationName: label,
				count: mergedCounts.get(key) ?? mergedCounts.get(f.name) ?? mergedCounts.get(f.barcode) ?? 0,
				capacity: f.capacity ?? null
			};
		}),
		ovenDistribution: (ovens as any[]).map((o: any) => ({
			locationId: String(o._id),
			locationName: o.name ?? o.barcode ?? String(o._id),
			count: ovenOccupantMap.get(String(o._id)) ?? 0,
			capacity: o.capacity ?? null
		})),
		expiringCount: expiringCartridges.length,
		expiringSoon: (expiringCartridges as any[]).map((c: any) => ({
			id: c._id,
			assay: c.reagentFilling?.assayType?.name ?? '—',
			expirationDate: c.reagentFilling?.expirationDate,
			phase: c.status
		})),
		recentActivity: (recentCartridges as any[]).map((c: any) => ({
			id: c._id,
			phase: c.status,
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

export const config = { maxDuration: 60 };
