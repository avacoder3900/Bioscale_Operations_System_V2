/**
 * Shared analytics aggregator for /kanban/analytics.
 *
 * One Mongo round-trip pulls all relevant tasks; one pass through each task's
 * activityLog builds the normalized timeline. Sibling widget PRDs extend the
 * returned shape with their specific blocks (kpi, cfd, throughput, etc.).
 *
 * Foundation version: returns the bare scaffolding. Each downstream PRD adds
 * its own field to AnalyticsData and its own block of compute logic here.
 */
import { connectDB, KanbanTask } from '$lib/server/db';

export type AnalyticsRange = '7d' | '30d' | '90d' | 'all';

export type AnalyticsData = {
	range: AnalyticsRange;
	since: Date | null; // null when range === 'all'
	taskCount: {
		total: number;
		active: number;       // not archived, not done
		archivedInRange: number;
	};
	// Future blocks populated by sibling PRDs:
	// kpi: KpiBlock;            // KPI-CARDS
	// cfd: CfdPoint[];          // CFD
	// throughput, cycleScatter, agingWip, timeInStatus  // FLOW-CHARTS
	// perProject, perAssignee, sourceMix  // BREAKDOWNS
	// wipTimeline (per-day)  // WIP-TIMELINE
};

export function rangeToSince(range: AnalyticsRange): Date | null {
	if (range === 'all') return null;
	const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
	const d = new Date();
	d.setDate(d.getDate() - days);
	d.setHours(0, 0, 0, 0);
	return d;
}

export function parseRange(raw: string | null): AnalyticsRange {
	if (raw === '7d' || raw === '30d' || raw === '90d' || raw === 'all') return raw;
	return '30d';
}

export async function loadAnalyticsData(range: AnalyticsRange): Promise<AnalyticsData> {
	await connectDB();
	const since = rangeToSince(range);

	const [activeTasks, archivedInRange] = await Promise.all([
		KanbanTask.find({ archived: false }).lean(),
		since
			? KanbanTask.find({ archived: true, archivedAt: { $gte: since } }).lean()
			: KanbanTask.find({ archived: true }).lean()
	]);

	const allTasks = [...activeTasks, ...archivedInRange];

	const active = activeTasks.filter((t: any) => t.status !== 'done').length;

	return {
		range,
		since,
		taskCount: {
			total: allTasks.length,
			active,
			archivedInRange: archivedInRange.length
		}
	};
}
