import { redirect } from '@sveltejs/kit';
import { connectDB, CartridgeRecord, Equipment, BackingLot, WaxFillingRun, ReagentBatchRecord } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { getCheckedOutCartridgeIds } from '$lib/server/checkout-utils';
import { groupCountsExcluding, totalOf } from '$lib/server/checked-out-counts';
import { dashboardCountSpecs } from '$lib/server/dashboard-count-specs';
import { buildPipeline } from '$lib/server/cartridge-pipeline';
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
	// Index-only counts minus the checked-out carts (PERF-01 BM-02); `$nin` on _id
	// made each of these a full collection scan.
	const counts = groupCountsExcluding(CartridgeRecord, dashboardCountSpecs(now), checkedOutIds);

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
		recentWaxRuns,
		recentReagentRuns
	] = await Promise.all([
		// Manufacturing pipeline phase counts
		counts.then((c) => c.phaseCounts),
		counts.then((c) => totalOf(c.totalMfg)),
		counts.then((c) => totalOf(c.totalVoided)),
		// Wax QC pass/fail
		counts.then((c) => c.waxQc),
		// Reagent inspection pass/fail
		counts.then((c) => c.reagentInspection),
		// Recent activity (last 20 updated)
		CartridgeRecord.find({ _id: { $nin: checkedOutIds } })
			.sort({ updatedAt: -1 })
			.limit(15)
			.lean(),
		// Expiring within 30 days (reagent fill expiration)
		CartridgeRecord.find({
			'reagentFilling.expirationDate': { $lte: thirtyDaysFromNow, $gte: now },
			status: { $nin: ['voided', 'completed', 'shipped'] },
			_id: { $nin: checkedOutIds }
		}).sort({ 'reagentFilling.expirationDate': 1 }).limit(10).lean(),
		// Fridge storage locations
		Equipment.find({ equipmentType: 'fridge', status: { $ne: 'offline' } }).lean().catch(() => []),
		// Oven/heater equipment
		Equipment.find({ equipmentType: 'oven', status: { $ne: 'offline' } }).lean().catch(() => []),
		// Weekly production (created in last 7 days)
		counts.then((c) => totalOf(c.weeklyProduction)),
		// Assay type breakdown
		counts.then((c) => c.assayBreakdown),
		// Last 7 days of wax + reagent runs — gives the dashboard a per-run
		// activity view that links into /cartridge-admin?runId=... so the
		// operator can see every cart in a run with its current state.
		WaxFillingRun.find({ createdAt: { $gte: sevenDaysAgo } })
			.sort({ createdAt: -1 })
			.select('_id status robot operator cartridgeIds plannedCartridgeCount runStartTime runEndTime createdAt abortReason')
			.lean(),
		ReagentBatchRecord.find({ createdAt: { $gte: sevenDaysAgo } })
			.sort({ createdAt: -1 })
			.select('_id status robot operator assayType cartridgesFilled cartridgeCount runStartTime runEndTime createdAt abortReason')
			.lean()
	]);

	// Storage distribution — merge three fridge buckets so totals match the
	// physical occupancy used elsewhere (/inventory/fridge-storage,
	// /equipment/activity, /equipment/fridges-ovens):
	//   wax_accepted (status∈WAX_STAGE_STATUSES)     — keyed by waxStorage.location
	//   wax_scrapped (status='scrapped' + waxStorage.location set) — QA quarantine
	//   reagent      (status∈{stored,reagent_filled}) — keyed by storage.fridgeName
	// Oven occupancy (WAX-FLOW-2): cartridges in the backing oven are individual
	// CartridgeRecords (status='backing', keyed by backing.ovenLocationId).
	// Legacy BackingLot aggregate buckets are still added per-oven until drained
	// — nothing writes to BackingLot any more.
	const [waxAcceptedCountsAgg, waxScrappedCountsAgg, reagentStorageCounts, backingCartOccupancyAgg, legacyOvenOccupancyAgg] = await Promise.all([
		counts.then((c) => c.waxStageByLocation),
		counts.then((c) => c.scrappedByLocation),
		counts.then((c) => c.reagentByFridge),
		counts.then((c) => c.backingByOven),
		BackingLot.aggregate([
			{ $match: { status: { $in: ['in_oven', 'ready'] }, ovenLocationId: { $exists: true, $ne: null } } },
			{ $group: { _id: '$ovenLocationId', count: { $sum: '$cartridgeCount' } } }
		]).catch(() => [])
	]);
	const ovenOccupancyAgg = [...(backingCartOccupancyAgg as any[]), ...(legacyOvenOccupancyAgg as any[])];
	const ovenOccupantMap = new Map<string, number>();
	for (const o of ovenOccupancyAgg as any[]) {
		const key = String(o._id);
		ovenOccupantMap.set(key, (ovenOccupantMap.get(key) ?? 0) + (o.count ?? 0));
	}
	const waxAcceptedMap = new Map<string, number>(
		(waxAcceptedCountsAgg as any[]).map((c: any) => [c._id, c.count])
	);
	const waxScrappedMap = new Map<string, number>(
		(waxScrappedCountsAgg as any[]).map((c: any) => [c._id, c.count])
	);
	const reagentMap = new Map<string, number>(
		(reagentStorageCounts as any[]).map((c: any) => [c._id, c.count])
	);
	const mergedCounts = new Map<string, number>();
	for (const s of [...waxAcceptedCountsAgg as any[], ...waxScrappedCountsAgg as any[], ...reagentStorageCounts as any[]]) {
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

	const qcMap = (arr: any[]) => {
		const m: Record<string, number> = {};
		for (const item of arr) m[item._id] = item.count;
		return m;
	};

	// Merge wax + reagent runs into one chronologically sorted list. Each entry
	// is shaped to feed the dashboard's run-history card and to deep-link into
	// /cartridge-admin?runId=... — same param the cartridge-admin filter reads.
	type RunNoteSummary = {
		count: number;
		lastBody: string | null;
		lastPhase: string | null;
		lastAuthor: string | null;
		lastCreatedAt: string | null;
	};
	const summarizeNotes = (notes: any[] | undefined): RunNoteSummary => {
		const arr = (notes ?? []) as any[];
		if (arr.length === 0) {
			return { count: 0, lastBody: null, lastPhase: null, lastAuthor: null, lastCreatedAt: null };
		}
		const sorted = arr.slice().sort((a, b) =>
			new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
		);
		const last = sorted[0];
		return {
			count: arr.length,
			lastBody: last.body ?? null,
			lastPhase: last.phase ?? null,
			lastAuthor: last.author?.username ?? null,
			lastCreatedAt: last.createdAt ? new Date(last.createdAt).toISOString() : null
		};
	};

	type RecentRun = {
		runId: string;
		processType: 'wax' | 'reagent';
		status: string;
		robotName: string | null;
		operatorName: string | null;
		assayName: string | null;
		cartridgeCount: number;
		startTime: string | null;
		endTime: string | null;
		createdAt: string;
		abortReason: string | null;
		notes: RunNoteSummary;
	};
	const recentRuns: RecentRun[] = [
		...(recentWaxRuns as any[]).map((r: any): RecentRun => ({
			runId: String(r._id),
			processType: 'wax',
			status: String(r.status ?? 'unknown'),
			robotName: r.robot?.name ?? r.robot?._id ?? null,
			operatorName: r.operator?.username ?? null,
			assayName: null,
			cartridgeCount: r.cartridgeIds?.length ?? r.plannedCartridgeCount ?? 0,
			startTime: r.runStartTime ? new Date(r.runStartTime).toISOString() : null,
			endTime: r.runEndTime ? new Date(r.runEndTime).toISOString() : null,
			createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : '',
			abortReason: r.abortReason ?? null,
			notes: summarizeNotes(r.notes)
		})),
		...(recentReagentRuns as any[]).map((r: any): RecentRun => ({
			runId: String(r._id),
			processType: 'reagent',
			status: String(r.status ?? 'unknown'),
			robotName: r.robot?.name ?? r.robot?._id ?? null,
			operatorName: r.operator?.username ?? null,
			assayName: r.assayType?.name ?? null,
			cartridgeCount: r.cartridgeCount ?? r.cartridgesFilled?.length ?? 0,
			startTime: r.runStartTime ? new Date(r.runStartTime).toISOString() : null,
			endTime: r.runEndTime ? new Date(r.runEndTime).toISOString() : null,
			createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : '',
			abortReason: r.abortReason ?? null,
			notes: summarizeNotes(r.notes)
		}))
	].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

	return {
		// Manufacturing pipeline
		pipeline: buildPipeline(phaseCounts as any[]),
		totalMfg,
		totalVoided,
		weeklyProduction,
		waxQc: qcMap(waxQcCounts as any[]),
		reagentInspection: qcMap(reagentInspCounts as any[]),
		assayBreakdown: (assayBreakdown as any[]).map((a: any) => ({ name: a._id, count: a.count })),
		storageDistribution: (fridges as any[]).map((f: any) => {
			const label = f.name ?? f.barcode ?? String(f._id);
			const key = f.barcode ?? f.name ?? String(f._id);
			const lookup = (m: Map<string, number>) =>
				m.get(key) ?? m.get(f.name) ?? m.get(f.barcode) ?? 0;
			return {
				locationId: String(f._id),
				locationName: label,
				count: lookup(mergedCounts),
				waxAcceptedCount: lookup(waxAcceptedMap),
				waxScrappedCount: lookup(waxScrappedMap),
				reagentCount: lookup(reagentMap),
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
		recentRuns
	};
};

export const config = { maxDuration: 60 };
