/**
 * KB2-15 — person-free historical chart data for the consolidated Flow view
 * (CFD, throughput, cycle scatter, aging, time-in-status, per-project, source
 * mix, KPI block). Ported from the retired analytics.ts, made board-aware.
 *
 * HARD CONSTRAINT — same as flow-metrics.ts, enforced here at the query layer:
 * nothing in this module returns per-person throughput, per-person cycle time,
 * leaderboards, or anything that trivially reconstructs them (KB2-00 decision
 * #12). The per-assignee table and creator-mix donut were deleted in KB2-15,
 * not moved — do not reintroduce them here.
 *
 * Computation replays activityLog status_change entries rather than the
 * transitions[] array: it is the only source that covers pre-KB2 archived
 * history, and transitionTask() writes identical entries, so it stays correct
 * for post-KB2 data too.
 */
import { connectDB, KanbanTask, KanbanProject } from '$lib/server/db';
import {
	ALL_STATUSES,
	STATUS_META,
	AGING_THRESHOLDS,
	agingLevel,
	type AgingLevel,
	type KanbanBoard,
	type KanbanStatus
} from '$lib/shared/kanban-status';

export type FlowHistoryRange = '7d' | '30d' | '90d' | 'all';

const MS_PER_DAY = 86_400_000;

export type KpiBlock = {
	activeTasks: number;
	throughputInRange: number;
	wipCount: number;
	wipAssignees: number;
	waitingCount: number;
	oldestWaitingDays: number | null;
	agingCount: number;
	criticalAgingCount: number;
};

export type CfdPoint = { date: string } & Record<KanbanStatus, number>;

export type ThroughputPoint = {
	weekStart: string; // YYYY-MM-DD
	total: number;
};

export type CycleScatterPoint = {
	taskId: string;
	title: string;
	completedAt: string;
	cycleTimeDays: number;
	projectColor: string;
};

export type CycleScatterBlock = {
	points: CycleScatterPoint[];
	p50: number | null;
	p85: number | null;
	p95: number | null;
};

export type AgingWipRow = {
	taskId: string;
	title: string;
	status: string;
	daysInStatus: number;
	severity: AgingLevel;
	statusColor: string;
};

export type TimeInStatusSegment = {
	status: string;
	days: number;
	color: string;
};

export type TimeInStatusRow = {
	taskId: string;
	title: string;
	totalDays: number;
	segments: TimeInStatusSegment[];
};

export type PerProjectRow = {
	id: string;
	name: string;
	color: string;
	active: number;
	doneInRange: number;
	medianCycleDays: number | null;
	wip: number;
	aging: number;
};

export type SourceMixSlice = {
	source: string;
	count: number;
};

export type FlowHistoryData = {
	range: FlowHistoryRange;
	taskCount: {
		total: number;
		active: number;
		archivedInRange: number;
	};
	kpi: KpiBlock;
	cfd: CfdPoint[];
	throughput: ThroughputPoint[];
	cycleScatter: CycleScatterBlock;
	agingWip: AgingWipRow[];
	timeInStatus: TimeInStatusRow[];
	perProject: PerProjectRow[];
	sourceMix: SourceMixSlice[];
};

export function rangeToSince(range: FlowHistoryRange): Date | null {
	if (range === 'all') return null;
	const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
	const d = new Date();
	d.setDate(d.getDate() - days);
	d.setHours(0, 0, 0, 0);
	return d;
}

export function parseRange(raw: string | null): FlowHistoryRange {
	if (raw === '7d' || raw === '30d' || raw === '90d' || raw === 'all') return raw;
	return '30d';
}

/**
 * Board filter that keeps pre-migration stragglers (docs without a board
 * field) on the ops board rather than silently dropping them.
 */
function boardFilter(board: KanbanBoard) {
	return board === 'software' ? { board: 'software' } : { board: { $ne: 'software' } };
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

	for (const t of allTasks) {
		const isArchived = !!t.archived;
		const status = t.status;

		if (!isArchived && status !== 'done') activeTasks++;

		// Throughput: anything currently done OR archived (and whose move-to-done
		// happened in range, approximated by statusChangedAt or archivedAt).
		if (status === 'done') {
			const ref = t.statusChangedAt ?? t.archivedAt ?? t.updatedAt;
			if (!since || (ref && new Date(ref).getTime() >= since.getTime())) {
				throughputInRange++;
			}
		}

		// WIP point-in-time. wipAssignees is a headcount, not a score — decision
		// #12 allows per-person WIP as a limit; a count of people with WIP is fine.
		if (!isArchived && status === 'wip') {
			wipCount++;
			if (t.assignee?._id) wipAssigneeIds.add(t.assignee._id);
		}

		if (!isArchived && status === 'waiting') {
			waitingCount++;
			const age = daysSince(t.statusChangedAt);
			if (age !== null && (oldestWaitingDays === null || age > oldestWaitingDays)) {
				oldestWaitingDays = age;
			}
		}

		if (!isArchived && status !== 'done') {
			const thresholds = AGING_THRESHOLDS[status as KanbanStatus];
			if (thresholds) {
				const age = daysSince(t.statusChangedAt);
				if (age !== null) {
					if (age >= thresholds.warn) agingCount++;
					if (age >= thresholds.critical) criticalAgingCount++;
				}
			}
		}
	}

	return {
		activeTasks,
		throughputInRange,
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
 * to 'captured' if no transition has occurred yet (matches schema default).
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

	let lastKnown = 'captured';
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

		const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<
			KanbanStatus,
			number
		>;
		for (const t of allTasks) {
			const status = getTaskStatusAt(t, eod);
			if (!status) continue;
			if (status in counts) counts[status as KanbanStatus]++;
		}

		points.push({
			date: endOfDay.toISOString().slice(0, 10),
			...counts
		});
	}
	return points;
}

const STATUS_COLORS: Record<string, string> = Object.fromEntries(
	ALL_STATUSES.map((s) => [s, STATUS_META[s].color])
);

function getCompletionMs(task: any): number | null {
	const log: any[] = task.activityLog ?? [];
	const doneEntry = log.find((e) => e.action === 'status_change' && e.details?.to === 'done');
	if (doneEntry) return new Date(doneEntry.createdAt).getTime();
	if (task.status === 'done') {
		return new Date(task.statusChangedAt ?? task.archivedAt ?? task.updatedAt ?? task.createdAt).getTime();
	}
	return null;
}

function isoMondayOf(ms: number): string {
	const d = new Date(ms);
	const dow = d.getUTCDay(); // 0..6
	const diffToMonday = (dow + 6) % 7;
	d.setUTCDate(d.getUTCDate() - diffToMonday);
	d.setUTCHours(0, 0, 0, 0);
	return d.toISOString().slice(0, 10);
}

function computeThroughput(allTasks: any[], since: Date | null): ThroughputPoint[] {
	const buckets = new Map<string, number>();
	const startMs = since?.getTime() ?? Date.now() - 90 * MS_PER_DAY;
	for (const t of allTasks) {
		if (t.status !== 'done') continue;
		const ms = getCompletionMs(t);
		if (ms === null || ms < startMs) continue;
		const wk = isoMondayOf(ms);
		buckets.set(wk, (buckets.get(wk) ?? 0) + 1);
	}
	return [...buckets.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([weekStart, total]) => ({ weekStart, total }));
}

function computeCycleScatter(allTasks: any[], since: Date | null): CycleScatterBlock {
	const points: CycleScatterPoint[] = [];
	const sinceMs = since?.getTime() ?? 0;
	for (const t of allTasks) {
		if (t.status !== 'done') continue;
		const ct = computeCycleTimeDays(t);
		if (ct === null) continue;
		const completedAtMs = getCompletionMs(t);
		if (completedAtMs === null || completedAtMs < sinceMs) continue;
		points.push({
			taskId: t._id,
			title: t.title,
			completedAt: new Date(completedAtMs).toISOString(),
			cycleTimeDays: Math.round(ct * 10) / 10,
			projectColor: t.project?.color ?? '#888'
		});
	}
	const cycleTimes = points.map((p) => p.cycleTimeDays);
	return {
		points,
		p50: percentile(cycleTimes, 50),
		p85: percentile(cycleTimes, 85),
		p95: percentile(cycleTimes, 95)
	};
}

function computeAgingWip(allTasks: any[]): AgingWipRow[] {
	const rows: AgingWipRow[] = [];
	for (const t of allTasks) {
		if (t.archived || t.status === 'done') continue;
		const days = daysSince(t.statusChangedAt);
		if (days === null) continue;
		const severity = agingLevel(t.status as KanbanStatus, days);
		if (severity === 'normal') continue;
		rows.push({
			taskId: t._id,
			title: t.title,
			status: t.status,
			daysInStatus: days,
			severity,
			statusColor: STATUS_COLORS[t.status] ?? '#888'
		});
	}
	rows.sort((a, b) => b.daysInStatus - a.daysInStatus);
	return rows.slice(0, 20);
}

function computeTimeInStatus(allTasks: any[], since: Date | null): TimeInStatusRow[] {
	const sinceMs = since?.getTime() ?? 0;
	const rows: TimeInStatusRow[] = [];
	for (const t of allTasks) {
		if (t.status !== 'done') continue;
		const completedAtMs = getCompletionMs(t);
		if (completedAtMs === null || completedAtMs < sinceMs) continue;

		const log: any[] = t.activityLog ?? [];
		const transitions = log
			.filter((e) => e.action === 'status_change' && e.details?.to)
			.map((e) => ({ to: e.details.to as string, t: new Date(e.createdAt).getTime() }))
			.sort((a, b) => a.t - b.t);
		if (transitions.length === 0) continue;

		const durations = new Map<string, number>();
		let prevStatus = 'captured';
		let prevTime = new Date(t.createdAt).getTime();
		for (const tr of transitions) {
			const dur = tr.t - prevTime;
			durations.set(prevStatus, (durations.get(prevStatus) ?? 0) + dur);
			prevStatus = tr.to;
			prevTime = tr.t;
		}

		const segments: TimeInStatusSegment[] = [...durations.entries()]
			.filter(([, ms]) => ms > 0)
			.map(([status, ms]) => ({
				status,
				days: Math.round((ms / MS_PER_DAY) * 10) / 10,
				color: STATUS_COLORS[status] ?? '#888'
			}));
		const totalDays = segments.reduce((acc, s) => acc + s.days, 0);
		if (totalDays <= 0) continue;
		rows.push({ taskId: t._id, title: t.title, totalDays, segments });
	}
	rows.sort((a, b) => b.totalDays - a.totalDays);
	return rows.slice(0, 20);
}

function computePerProject(allTasks: any[], since: Date | null, allProjects: any[]): PerProjectRow[] {
	const sinceMs = since?.getTime() ?? 0;
	const rows: PerProjectRow[] = [];
	for (const p of allProjects) {
		const ofProject = allTasks.filter((t: any) => t.project?._id === p._id);
		const active = ofProject.filter((t: any) => !t.archived && t.status !== 'done').length;
		const doneInRange = ofProject.filter((t: any) => {
			if (t.status !== 'done') return false;
			const ms = getCompletionMs(t);
			return ms !== null && ms >= sinceMs;
		}).length;
		const wip = ofProject.filter((t: any) => !t.archived && t.status === 'wip').length;
		const aging = ofProject.filter((t: any) => {
			if (t.archived || t.status === 'done') return false;
			const days = daysSince(t.statusChangedAt);
			return days !== null && agingLevel(t.status as KanbanStatus, days) !== 'normal';
		}).length;
		const cycleTimes = ofProject
			.filter((t: any) => {
				if (t.status !== 'done') return false;
				const ms = getCompletionMs(t);
				return ms !== null && ms >= sinceMs;
			})
			.map((t: any) => computeCycleTimeDays(t))
			.filter((x): x is number => x !== null);
		const medianCycleDays = percentile(cycleTimes, 50);
		rows.push({
			id: p._id,
			name: p.name,
			color: p.color ?? '#888',
			active,
			doneInRange,
			medianCycleDays,
			wip,
			aging
		});
	}
	rows.sort((a, b) => b.doneInRange - a.doneInRange);
	return rows;
}

/**
 * Binary source mix: how did the task enter the system?
 * `manual` = direct UI; `agent` = any non-manual source (agent API, telegram,
 * meeting synthesis, operations-trigger, etc.).
 */
function computeSourceMix(allTasks: any[], since: Date | null): SourceMixSlice[] {
	const sinceMs = since?.getTime() ?? 0;
	let manual = 0;
	let agent = 0;
	for (const t of allTasks) {
		const ref = new Date(t.createdAt).getTime();
		if (ref < sinceMs) continue;
		const src = t.source ?? 'manual';
		if (src === 'manual') manual++;
		else agent++;
	}
	return [
		{ source: 'manual', count: manual },
		{ source: 'agent', count: agent }
	].filter((s) => s.count > 0);
}

export async function loadFlowHistory(
	board: KanbanBoard,
	range: FlowHistoryRange
): Promise<FlowHistoryData> {
	await connectDB();
	const since = rangeToSince(range);
	const bf = boardFilter(board);

	const [activeTasks, archivedInRange, allProjects] = await Promise.all([
		KanbanTask.find({ ...bf, archived: false }).lean(),
		since
			? KanbanTask.find({ ...bf, archived: true, archivedAt: { $gte: since } }).lean()
			: KanbanTask.find({ ...bf, archived: true }).lean(),
		KanbanProject.find({ isActive: true }).lean()
	]);

	const allTasks = [...activeTasks, ...archivedInRange];
	const active = activeTasks.filter((t: any) => t.status !== 'done').length;

	return {
		range,
		taskCount: {
			total: allTasks.length,
			active,
			archivedInRange: archivedInRange.length
		},
		kpi: computeKpi(allTasks, since),
		cfd: computeCfd(allTasks, since),
		throughput: computeThroughput(allTasks, since),
		cycleScatter: computeCycleScatter(allTasks, since),
		agingWip: computeAgingWip(allTasks),
		timeInStatus: computeTimeInStatus(allTasks, since),
		perProject: computePerProject(allTasks, since, allProjects),
		sourceMix: computeSourceMix(allTasks, since)
	};
}
