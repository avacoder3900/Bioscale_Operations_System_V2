/**
 * Shared analytics aggregator for /kanban/analytics.
 *
 * One Mongo round-trip pulls all relevant tasks; one pass through each task's
 * activityLog builds the normalized timeline. Sibling widget PRDs extend the
 * returned shape with their specific blocks.
 */
import { connectDB, KanbanTask } from '$lib/server/db';
import { agingThresholds } from '$lib/shared/kanban-aging';

export type AnalyticsRange = '7d' | '30d' | '90d' | 'all';

const MS_PER_DAY = 86_400_000;

export type KpiBlock = {
	activeTasks: number;
	throughputInRange: number;
	medianCycleTimeDays: number | null;
	p85CycleTimeDays: number | null;
	wipCount: number;
	wipAssignees: number;
	waitingCount: number;
	oldestWaitingDays: number | null;
	agingCount: number;
	criticalAgingCount: number;
};

export type CfdPoint = {
	date: string; // YYYY-MM-DD
	backlog: number;
	ready: number;
	wip: number;
	waiting: number;
	done: number;
};

export type AnalyticsData = {
	range: AnalyticsRange;
	since: Date | null;
	taskCount: {
		total: number;
		active: number;
		archivedInRange: number;
	};
	kpi: KpiBlock;
	cfd: CfdPoint[];
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

function percentile(arr: number[], p: number): number | null {
	if (arr.length === 0) return null;
	const sorted = [...arr].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}

/**
 * For a single task, find the cycle time from first `→ wip` entry to first
 * `→ done` entry. Returns null if either transition isn't recorded.
 */
function computeCycleTimeDays(task: any): number | null {
	const log: any[] = task.activityLog ?? [];
	let wipAt: number | null = null;
	let doneAt: number | null = null;
	for (const entry of log) {
		if (entry.action !== 'status_change') continue;
		const to = entry.details?.to;
		const t = new Date(entry.createdAt).getTime();
		if (to === 'wip' && wipAt === null) wipAt = t;
		if (to === 'done' && doneAt === null) doneAt = t;
		if (wipAt !== null && doneAt !== null) break;
	}
	if (wipAt === null || doneAt === null || doneAt < wipAt) return null;
	return (doneAt - wipAt) / MS_PER_DAY;
}

function daysSince(d: Date | string | null | undefined): number | null {
	if (!d) return null;
	return Math.floor((Date.now() - new Date(d).getTime()) / MS_PER_DAY);
}

function computeKpi(allTasks: any[], since: Date | null): KpiBlock {
	let activeTasks = 0;
	let throughputInRange = 0;
	let wipCount = 0;
	let waitingCount = 0;
	let oldestWaitingDays: number | null = null;
	let agingCount = 0;
	let criticalAgingCount = 0;
	const wipAssigneeIds = new Set<string>();
	const cycleTimes: number[] = [];

	for (const t of allTasks) {
		const isArchived = !!t.archived;
		const status = t.status;

		// Active = not archived AND not done
		if (!isArchived && status !== 'done') activeTasks++;

		// Throughput: anything currently done OR archived (and whose move-to-done
		// happened in range, approximated by statusChangedAt or archivedAt).
		if (status === 'done') {
			const ref = t.statusChangedAt ?? t.archivedAt ?? t.updatedAt;
			if (!since || (ref && new Date(ref).getTime() >= since.getTime())) {
				throughputInRange++;
			}
			const ct = computeCycleTimeDays(t);
			if (ct !== null) {
				if (!since || (ref && new Date(ref).getTime() >= since.getTime())) {
					cycleTimes.push(ct);
				}
			}
		}

		// WIP point-in-time
		if (!isArchived && status === 'wip') {
			wipCount++;
			if (t.assignee?._id) wipAssigneeIds.add(t.assignee._id);
		}

		// Waiting point-in-time
		if (!isArchived && status === 'waiting') {
			waitingCount++;
			const age = daysSince(t.statusChangedAt);
			if (age !== null && (oldestWaitingDays === null || age > oldestWaitingDays)) {
				oldestWaitingDays = age;
			}
		}

		// Aging — non-done, non-archived, daysInStatus over the warning threshold
		if (!isArchived && status !== 'done') {
			const thresholds = agingThresholds[status];
			if (thresholds) {
				const age = daysSince(t.statusChangedAt);
				if (age !== null) {
					if (age > thresholds.warning) agingCount++;
					if (age > thresholds.critical) criticalAgingCount++;
				}
			}
		}
	}

	return {
		activeTasks,
		throughputInRange,
		medianCycleTimeDays: percentile(cycleTimes, 50),
		p85CycleTimeDays: percentile(cycleTimes, 85),
		wipCount,
		wipAssignees: wipAssigneeIds.size,
		waitingCount,
		oldestWaitingDays,
		agingCount,
		criticalAgingCount
	};
}

/**
 * Status of a task at a given point in time. Built by replaying the task's
 * activityLog (sorted, status_change entries only) up to `atMs`. Tasks default
 * to 'backlog' if no transition has occurred yet (matches schema default).
 * Archived tasks count as 'done' once archivedAt is in the past.
 */
function getTaskStatusAt(task: any, atMs: number): string | null {
	const createdAt = new Date(task.createdAt).getTime();
	if (atMs < createdAt) return null;

	if (task.archived) {
		const archivedAt = task.archivedAt ? new Date(task.archivedAt).getTime() : null;
		if (archivedAt !== null && atMs >= archivedAt) return 'done';
	}

	const log: any[] = task.activityLog ?? [];
	const transitions = log
		.filter((e) => e.action === 'status_change' && e.details?.to)
		.map((e) => ({ to: e.details.to as string, t: new Date(e.createdAt).getTime() }))
		.sort((a, b) => a.t - b.t);

	let lastKnown = 'backlog';
	for (const tr of transitions) {
		if (tr.t > atMs) break;
		lastKnown = tr.to;
	}
	return lastKnown;
}

function computeCfd(allTasks: any[], since: Date | null): CfdPoint[] {
	const now = Date.now();
	let start: number;
	if (since) {
		start = since.getTime();
	} else {
		// 'all' — find earliest createdAt or fall back to 30 days ago
		const earliest = allTasks.reduce((min, t) => {
			const c = new Date(t.createdAt).getTime();
			return min === null || c < min ? c : min;
		}, null as number | null);
		start = earliest ?? now - 30 * MS_PER_DAY;
	}
	const totalSpanDays = Math.ceil((now - start) / MS_PER_DAY);
	const stepDays = totalSpanDays > 180 ? 7 : 1; // weekly for long ranges

	const points: CfdPoint[] = [];
	for (let d = start; d <= now; d += stepDays * MS_PER_DAY) {
		const endOfDay = new Date(d);
		endOfDay.setHours(23, 59, 59, 999);
		const eod = endOfDay.getTime();

		const counts = { backlog: 0, ready: 0, wip: 0, waiting: 0, done: 0 };
		for (const t of allTasks) {
			const status = getTaskStatusAt(t, eod);
			if (!status) continue;
			if (status in counts) counts[status as keyof typeof counts]++;
		}

		points.push({
			date: endOfDay.toISOString().slice(0, 10),
			...counts
		});
	}
	return points;
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
		},
		kpi: computeKpi(allTasks, since),
		cfd: computeCfd(allTasks, since)
	};
}
