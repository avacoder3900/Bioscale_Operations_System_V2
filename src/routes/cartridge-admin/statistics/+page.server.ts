import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, ReagentBatchRecord, AssayDefinition } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const range = url.searchParams.get('range') ?? '30d';

	// Calculate date range
	const now = new Date();
	const days = range === '7d' ? 7 : range === '90d' ? 90 : range === '1y' ? 365 : 30;
	const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

	const [cartridges, runs, assayTypes] = await Promise.all([
		CartridgeRecord.find({ createdAt: { $gte: since } }, {
			status: 1,
			'reagentFilling.assayType': 1,
			'reagentInspection.status': 1,
			'reagentInspection.reason': 1,
			'reagentInspection.operator': 1,
			createdAt: 1
		}).lean(),
		ReagentBatchRecord.find({ createdAt: { $gte: since } }, {
			'assayType._id': 1, 'assayType.name': 1,
			status: 1, cartridgeCount: 1, 'operator._id': 1, 'operator.username': 1,
			runStartTime: 1, cartridgesFilled: 1
		}).lean(),
		AssayDefinition.find({ isActive: true, hidden: { $ne: true } }, { _id: 1, name: 1 }).lean()
	]);

	const cs = cartridges as any[];
	const rs = runs as any[];

	// Yield statistics
	const totalBacked = cs.length;
	const phases = ['wax_filled', 'wax_stored', 'wax_ready', 'reagent_filled', 'inspected', 'sealed', 'stored', 'released'];
	const phaseCounts = phases.map((phase) => {
		const count = cs.filter((c) => {
			const phaseOrder = ['wax_filled', 'wax_stored', 'wax_qc', 'wax_ready', 'reagent_filled', 'inspected', 'sealed', 'cured', 'stored', 'released'];
			return phaseOrder.indexOf(c.status) >= phaseOrder.indexOf(phase);
		}).length;
		return {
			stage: phase.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
			count,
			percentage: cs.length > 0 ? count / cs.length : 0
		};
	});
	const finalCount = cs.filter((c) => ['stored', 'released', 'shipped'].includes(c.status)).length;
	const overallYield = totalBacked > 0 ? finalCount / totalBacked : 0;

	// Throughput
	const totalCompleted = cs.filter((c) => ['stored', 'released', 'shipped'].includes(c.status)).length;
	const totalInProgress = cs.filter((c) => ['reagent_filled', 'inspected', 'sealed', 'cured'].includes(c.status)).length;

	// Daily counts
	const dailyMap = new Map<string, number>();
	for (let i = 0; i < Math.min(days, 30); i++) {
		const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
		const key = d.toISOString().split('T')[0];
		dailyMap.set(key, 0);
	}
	cs.forEach((c) => {
		const key = new Date(c.createdAt).toISOString().split('T')[0];
		if (dailyMap.has(key)) dailyMap.set(key, (dailyMap.get(key) ?? 0) + 1);
	});
	const dailyCounts = [...dailyMap.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, count]) => ({ date, count }));

	// Failure rates
	const totalInspected = cs.filter((c) => c.reagentInspection?.status).length;
	const rejected = cs.filter((c) => c.reagentInspection?.status === 'Rejected').length;
	const rejectionRate = totalInspected > 0 ? rejected / totalInspected : 0;
	const qaqcInspected = cs.filter((c) => (c as any).qaqc?.status).length;
	const qaqcFailed = cs.filter((c) => (c as any).qaqc?.status === 'Failed' || (c as any).qaqc?.status === 'Rejected').length;
	const qaqcRate = qaqcInspected > 0 ? qaqcFailed / qaqcInspected : 0;
	const waxRejectedCount = cs.filter((c) => c.status === 'wax_rejected' || (c as any).waxQc?.status === 'Rejected').length;

	// Rejection breakdown
	const rejectionMap = new Map<string, number>();
	cs.forEach((c) => {
		if (c.reagentInspection?.status === 'Rejected' && c.reagentInspection?.reason) {
			const code = c.reagentInspection.reason;
			rejectionMap.set(code, (rejectionMap.get(code) ?? 0) + 1);
		}
	});
	const rejectionBreakdown = [...rejectionMap.entries()].map(([reasonCode, count]) => ({
		reasonCode,
		count,
		label: reasonCode.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
	}));

	// Operator stats
	type OperatorStat = {
		operatorId: string; username: string; operatorName: string;
		runCount: number; cartridgeCount: number; cartridgesProcessed: number;
		rejectedCount: number; rejectionRate: number;
	};
	const opMap = new Map<string, OperatorStat>();
	rs.forEach((run) => {
		const opId = run.operator?._id;
		const opName = run.operator?.username ?? 'Unknown';
		if (!opId) return;
		const existing = opMap.get(opId) ?? {
			operatorId: opId, username: opName, operatorName: opName,
			runCount: 0, cartridgeCount: 0, cartridgesProcessed: 0,
			rejectedCount: 0, rejectionRate: 0
		};
		existing.runCount++;
		const carts = (run.cartridgesFilled ?? []) as any[];
		const runCarts = run.cartridgeCount ?? carts.length ?? 0;
		existing.cartridgeCount += runCarts;
		existing.cartridgesProcessed += runCarts;
		existing.rejectedCount += carts.filter((c) => c.inspectionStatus === 'Rejected').length;
		opMap.set(opId, existing);
	});
	const operatorStats = [...opMap.values()].map((o) => ({
		...o,
		rejectionRate: o.cartridgesProcessed > 0 ? o.rejectedCount / o.cartridgesProcessed : 0
	}));

	// Assay type stats
	type AssayTypeStat = {
		assayTypeId: string; name: string; assayTypeName: string;
		runCount: number; cartridgeCount: number; totalCartridges: number;
		completedCartridges: number; yieldRate: number;
	};
	const assayMap = new Map<string, AssayTypeStat>();
	rs.forEach((run) => {
		const assayId = run.assayType?._id;
		if (!assayId) return;
		const name = run.assayType?.name ?? 'Unknown';
		const existing = assayMap.get(assayId) ?? {
			assayTypeId: assayId, name, assayTypeName: name,
			runCount: 0, cartridgeCount: 0, totalCartridges: 0,
			completedCartridges: 0, yieldRate: 0
		};
		existing.runCount++;
		const carts = (run.cartridgesFilled ?? []) as any[];
		const runCarts = run.cartridgeCount ?? carts.length ?? 0;
		existing.cartridgeCount += runCarts;
		existing.totalCartridges += runCarts;
		existing.completedCartridges += carts.filter((c) => c.inspectionStatus === 'Accepted').length;
		assayMap.set(assayId, existing);
	});
	const assayTypeStats = [...assayMap.values()].map((a) => ({
		...a,
		yieldRate: a.totalCartridges > 0 ? a.completedCartridges / a.totalCartridges : 0
	}));

	return {
		rangeParam: range,
		yieldStats: {
			totalBacked,
			overallYield,
			stageFalloff: phaseCounts
		},
		throughput: {
			totalCompleted,
			totalInProgress,
			dailyCounts
		},
		failureRates: {
			totalInspected,
			rejectionRate,
			qaqcRate,
			waxRejectedCount
		},
		rejectionBreakdown,
		operatorStats,
		assayTypeStats
	};
};

export const config = { maxDuration: 60 };
