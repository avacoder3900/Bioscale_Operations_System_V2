/**
 * Shared analytics aggregator for /kanban/analytics.
 *
 * One Mongo round-trip pulls all relevant tasks; one pass through each task's
 * activityLog builds the normalized timeline. Sibling widget PRDs extend the
 * returned shape with their specific blocks.
 */
import { connectDB, KanbanTask, User } from '$lib/server/db';
import {
	ALL_STATUSES,
	STATUS_META,
	AGING_THRESHOLDS,
	agingLevel,
	type AgingLevel,
	type KanbanStatus
} from '$lib/shared/kanban-status';

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

export type CfdPoint = { date: string } & Record<KanbanStatus, number>;

export type WipSegment = {
	taskId: string;
	taskTitle: string;
	projectColor: string;
	startBucket: number; // 0=before 7am, 1..44=regular 15-min cells (7:00..17:45), 45=after 6pm
	endBucket: number;   // exclusive; fill cells [startBucket, endBucket)
	startUtc: string;
	endUtc: string | null;
};

export type WipLane = {
	laneIndex: number;
	isOverflow: boolean;
	segments: WipSegment[];
};

export type WipTimelinePerson = {
	userId: string;
	username: string;
	wipLimit: number;
	lanes: WipLane[];
};

export type WipTimelineData = {
	day: string; // YYYY-MM-DD
	dayStartUtc: string;
	dayEndUtc: string;
	people: WipTimelinePerson[];
};

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

export type PerAssigneeRow = {
	id: string;
	username: string;
	active: number;
	doneInRange: number;
	loadScore: number;
	wip: number;
	aging: number;
};

export type SourceMixSlice = {
	source: string;
	count: number;
};

export type CreatorMixSlice = {
	userId: string;
	username: string;
	count: number;
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
	wipTimeline: WipTimelineData;
	throughput: ThroughputPoint[];
	cycleScatter: CycleScatterBlock;
	agingWip: AgingWipRow[];
	timeInStatus: TimeInStatusRow[];
	perProject: PerProjectRow[];
	perAssignee: PerAssigneeRow[];
	sourceMix: SourceMixSlice[];
	creatorMix: CreatorMixSlice[];
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

		// Aging — non-done, non-archived, daysInStatus over the warn threshold
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

/**
 * Compute the 0-45 bucket index for a UTC ms timestamp relative to the chart
 * day's start (local midnight in UTC). 0 = before 7 AM overflow, 1..44 =
 * regular 15-min cells (7:00..17:45 → 1..44), 45 = after 6 PM overflow.
 * Returns 46 if the timestamp falls past end-of-day (used as an exclusive
 * upper bound when a wip interval extends into the next day).
 */
function bucketIndexFor(ms: number, dayStartMs: number): number {
	const dayEndMs = dayStartMs + 24 * 3600_000;
	if (ms < dayStartMs) return 0; // carry-over from prior day
	if (ms >= dayEndMs) return 46;
	const offsetMs = ms - dayStartMs;
	const sevenAm = 7 * 3600_000;
	const sixPm = 18 * 3600_000;
	if (offsetMs < sevenAm) return 0;
	if (offsetMs >= sixPm) return 45;
	const minutesFrom7 = (offsetMs - sevenAm) / 60_000;
	return 1 + Math.floor(minutesFrom7 / 15);
}

/**
 * Walk a task's activityLog to extract every [enterWipMs, exitWipMs] interval.
 * If the task is currently in wip with no later transition, exitWipMs is null
 * (caller clips it to `now` when rendering today's chart).
 */
function extractWipIntervals(task: any): { enterMs: number; exitMs: number | null }[] {
	const log: any[] = task.activityLog ?? [];
	const transitions = log
		.filter((e) => e.action === 'status_change' && e.details?.to)
		.map((e) => ({ to: e.details.to as string, from: e.details.from as string | undefined, t: new Date(e.createdAt).getTime() }))
		.sort((a, b) => a.t - b.t);

	const intervals: { enterMs: number; exitMs: number | null }[] = [];
	let openEnter: number | null = null;
	for (const tr of transitions) {
		if (tr.to === 'wip' && openEnter === null) openEnter = tr.t;
		else if (tr.to !== 'wip' && openEnter !== null) {
			intervals.push({ enterMs: openEnter, exitMs: tr.t });
			openEnter = null;
		}
	}
	// Still in WIP if the last transition into wip wasn't matched by a transition out.
	if (openEnter !== null && task.status === 'wip') {
		intervals.push({ enterMs: openEnter, exitMs: null });
	}
	return intervals;
}

/**
 * Resolve `?day=YYYY-MM-DD` against the viewer's local clock. `tzOffsetMin` is
 * `Date.prototype.getTimezoneOffset()` from the browser — minutes that local
 * time lags UTC (e.g. +300 for CDT, +360 for CST). dayStartMs comes back as the
 * UTC instant of local-midnight, so segment bucketing lines up with the
 * client's headers and now-line.
 */
function parseDayParam(
	raw: string | null,
	tzOffsetMin: number = 0
): { day: string; dayStartMs: number } {
	if (raw) {
		const utcMidnight = Date.parse(`${raw}T00:00:00Z`);
		return { day: raw, dayStartMs: utcMidnight + tzOffsetMin * 60_000 };
	}
	// No raw — figure out the viewer's local date.
	const nowUtc = Date.now();
	const localShifted = new Date(nowUtc - tzOffsetMin * 60_000);
	const y = localShifted.getUTCFullYear();
	const m = String(localShifted.getUTCMonth() + 1).padStart(2, '0');
	const d = String(localShifted.getUTCDate()).padStart(2, '0');
	const day = `${y}-${m}-${d}`;
	const utcMidnight = Date.parse(`${day}T00:00:00Z`);
	return { day, dayStartMs: utcMidnight + tzOffsetMin * 60_000 };
}

function assignLanes(
	segments: WipSegment[],
	wipLimit: number
): WipLane[] {
	// Unassigned (wipLimit=0) is special: render one lane per segment so they
	// stay visible. There's no cap to honor here.
	if (wipLimit === 0) {
		const sorted = [...segments].sort((a, b) => a.startBucket - b.startBucket);
		return sorted.map((seg, i) => ({ laneIndex: i, isOverflow: false, segments: [seg] }));
	}

	// Always return exactly `wipLimit` lanes. Greedy non-overlapping placement
	// in the lowest-numbered free lane. If every lane has a conflicting segment,
	// stack inside the lane whose last segment ended earliest — this is the
	// "combo slot" behavior: two tasks share a row, the older one ended and
	// the newer one started later. KANBAN-WIP-LIMIT-ENFORCEMENT caps live WIP
	// at wipLimit, so true simultaneous overlap should be impossible.
	const sorted = [...segments].sort((a, b) => a.startBucket - b.startBucket);
	const lanes: WipSegment[][] = Array.from({ length: wipLimit }, () => []);

	for (const seg of sorted) {
		let placed = false;
		for (let i = 0; i < wipLimit; i++) {
			const lane = lanes[i];
			const last = lane[lane.length - 1];
			if (!last || last.endBucket <= seg.startBucket) {
				lane.push(seg);
				placed = true;
				break;
			}
		}
		if (!placed) {
			let bestLane = 0;
			let bestEnd = lanes[0][lanes[0].length - 1]!.endBucket;
			for (let i = 1; i < wipLimit; i++) {
				const lastEnd = lanes[i][lanes[i].length - 1]!.endBucket;
				if (lastEnd < bestEnd) {
					bestLane = i;
					bestEnd = lastEnd;
				}
			}
			lanes[bestLane].push(seg);
		}
	}

	return lanes.map((segs, i) => ({ laneIndex: i, isOverflow: false, segments: segs }));
}

async function computeWipTimeline(allTasks: any[], dayStartMs: number, day: string): Promise<WipTimelineData> {
	const dayEndMs = dayStartMs + 24 * 3600_000;
	const now = Date.now();

	// Build per-assignee segment list
	type AccPerson = { userId: string; username: string; segments: WipSegment[] };
	const byAssignee = new Map<string, AccPerson>();

	for (const task of allTasks) {
		const assigneeId = task.assignee?._id;
		const assigneeName = task.assignee?.username ?? '— Unassigned —';
		const projectColor = task.project?.color ?? '#888888';

		const intervals = extractWipIntervals(task);
		for (const iv of intervals) {
			const enter = iv.enterMs;
			// Cap still-in-WIP intervals at `now`, not the chart day's end. This
			// stops future-day views from showing "predicted" activity for tasks
			// that are currently still in WIP. Past-day views still fill normally
			// since `now` will be > that day's dayEndMs.
			const exit = iv.exitMs ?? now;
			// Skip intervals that don't overlap with today
			if (exit <= dayStartMs) continue;
			if (enter >= dayEndMs) continue;

			const clippedStart = Math.max(enter, dayStartMs);
			const clippedEnd = Math.min(exit, dayEndMs);
			if (clippedEnd <= clippedStart) continue;

			const seg: WipSegment = {
				taskId: task._id,
				taskTitle: task.title,
				projectColor,
				startBucket: bucketIndexFor(clippedStart, dayStartMs),
				endBucket: bucketIndexFor(clippedEnd, dayStartMs),
				startUtc: new Date(iv.enterMs).toISOString(),
				endUtc: iv.exitMs ? new Date(iv.exitMs).toISOString() : null
			};

			const key = assigneeId ?? '__unassigned__';
			if (!byAssignee.has(key)) {
				byAssignee.set(key, { userId: key, username: assigneeName, segments: [] });
			}
			byAssignee.get(key)!.segments.push(seg);
		}
	}

	// Also surface "active kanban participants" who happen to have zero WIP
	// segments today — anyone assigned to a non-archived, non-done task. They
	// render as wipLimit empty lanes, signalling "room to take another."
	for (const task of allTasks) {
		if (task.archived || task.status === 'done') continue;
		const id = task.assignee?._id;
		if (!id) continue;
		if (byAssignee.has(id)) continue;
		byAssignee.set(id, { userId: id, username: task.assignee.username ?? id, segments: [] });
	}

	// Resolve wipLimit per user
	const userIds = [...byAssignee.keys()].filter((k) => k !== '__unassigned__');
	const userDocs = userIds.length
		? ((await User.find({ _id: { $in: userIds } }).select('_id username wipLimit').lean()) as any[])
		: [];
	const userMap = new Map(userDocs.map((u) => [u._id, u]));

	const people: WipTimelinePerson[] = [];
	for (const [key, acc] of byAssignee.entries()) {
		const userDoc = userMap.get(key);
		const wipLimit = userDoc ? (typeof userDoc.wipLimit === 'number' ? userDoc.wipLimit : 3) : 0;
		people.push({
			userId: key,
			username: userDoc?.username ?? acc.username,
			wipLimit,
			lanes: assignLanes(acc.segments, wipLimit)
		});
	}

	// Sort: real users by name, unassigned last
	people.sort((a, b) => {
		if (a.userId === '__unassigned__') return 1;
		if (b.userId === '__unassigned__') return -1;
		return a.username.localeCompare(b.username);
	});

	return {
		day,
		dayStartUtc: new Date(dayStartMs).toISOString(),
		dayEndUtc: new Date(dayEndMs).toISOString(),
		people
	};
}

const STATUS_COLORS: Record<string, string> = Object.fromEntries(
	ALL_STATUSES.map((s) => [s, STATUS_META[s].color])
);

// Load-score weights by sizeClass (unsized items count as medium).
const SIZE_WEIGHTS: Record<string, number> = { short: 1, medium: 2, long: 4 };

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

function computePerAssignee(allTasks: any[], since: Date | null): PerAssigneeRow[] {
	const sinceMs = since?.getTime() ?? 0;
	const byUser = new Map<string, { username: string; tasks: any[] }>();
	for (const t of allTasks) {
		const id = t.assignee?._id ?? '__unassigned__';
		const name = t.assignee?.username ?? '— Unassigned —';
		if (!byUser.has(id)) byUser.set(id, { username: name, tasks: [] });
		byUser.get(id)!.tasks.push(t);
	}
	const rows: PerAssigneeRow[] = [];
	for (const [id, { username, tasks }] of byUser) {
		const activeTasks = tasks.filter((t: any) => !t.archived && t.status !== 'done');
		const active = activeTasks.length;
		const doneInRange = tasks.filter((t: any) => {
			if (t.status !== 'done') return false;
			const ms = getCompletionMs(t);
			return ms !== null && ms >= sinceMs;
		}).length;
		const wip = tasks.filter((t: any) => !t.archived && t.status === 'wip').length;
		const aging = tasks.filter((t: any) => {
			if (t.archived || t.status === 'done') return false;
			const days = daysSince(t.statusChangedAt);
			return days !== null && agingLevel(t.status as KanbanStatus, days) !== 'normal';
		}).length;
		const loadScore = activeTasks.reduce(
			(acc: number, t: any) => acc + (SIZE_WEIGHTS[t.sizeClass ?? 'medium'] ?? 2),
			0
		);
		rows.push({ id, username, active, doneInRange, loadScore, wip, aging });
	}
	rows.sort((a, b) => {
		if (a.id === '__unassigned__') return 1;
		if (b.id === '__unassigned__') return -1;
		return b.loadScore - a.loadScore;
	});
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

/**
 * Creator mix: who originated each task? Groups by `createdBy` user ID
 * (resolved to username via the supplied map). NB: if the agent records its
 * own user ID on agent-created tasks, those bucket together as that user
 * rather than the human who triggered the agent.
 */
function computeCreatorMix(
	allTasks: any[],
	since: Date | null,
	usernameMap: Map<string, string>
): CreatorMixSlice[] {
	const sinceMs = since?.getTime() ?? 0;
	const counts = new Map<string, number>();
	for (const t of allTasks) {
		const ref = new Date(t.createdAt).getTime();
		if (ref < sinceMs) continue;
		const uid = t.createdBy ?? 'unknown';
		counts.set(uid, (counts.get(uid) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([userId, count]) => ({
			userId,
			username: usernameMap.get(userId) ?? userId,
			count
		}))
		.sort((a, b) => b.count - a.count);
}

export async function loadAnalyticsData(
	range: AnalyticsRange,
	dayRaw: string | null = null,
	tzOffsetMin: number = 0
): Promise<AnalyticsData> {
	await connectDB();
	const since = rangeToSince(range);

	const { KanbanProject } = await import('$lib/server/db');

	const [activeTasks, archivedInRange, allProjects] = await Promise.all([
		KanbanTask.find({ archived: false }).lean(),
		since
			? KanbanTask.find({ archived: true, archivedAt: { $gte: since } }).lean()
			: KanbanTask.find({ archived: true }).lean(),
		KanbanProject.find({ isActive: true }).lean()
	]);

	const allTasks = [...activeTasks, ...archivedInRange];
	const active = activeTasks.filter((t: any) => t.status !== 'done').length;

	// Resolve createdBy user IDs to usernames for the Creator Mix chart.
	const creatorIds = [...new Set(allTasks.map((t: any) => t.createdBy).filter(Boolean))] as string[];
	const creatorDocs = creatorIds.length
		? ((await User.find({ _id: { $in: creatorIds } }).select('_id username').lean()) as any[])
		: [];
	const usernameMap = new Map<string, string>(creatorDocs.map((u: any) => [u._id, u.username]));

	const { day, dayStartMs } = parseDayParam(dayRaw, tzOffsetMin);
	const wipTimeline = await computeWipTimeline(allTasks, dayStartMs, day);

	return {
		range,
		since,
		taskCount: {
			total: allTasks.length,
			active,
			archivedInRange: archivedInRange.length
		},
		kpi: computeKpi(allTasks, since),
		cfd: computeCfd(allTasks, since),
		wipTimeline,
		throughput: computeThroughput(allTasks, since),
		cycleScatter: computeCycleScatter(allTasks, since),
		agingWip: computeAgingWip(allTasks),
		timeInStatus: computeTimeInStatus(allTasks, since),
		perProject: computePerProject(allTasks, since, allProjects),
		perAssignee: computePerAssignee(allTasks, since),
		sourceMix: computeSourceMix(allTasks, since),
		creatorMix: computeCreatorMix(allTasks, since, usernameMap)
	};
}

/**
 * Lightweight wrapper for polling — returns just the WIP timeline block.
 * Used by /api/kanban/wip-timeline.
 */
export async function loadWipTimeline(
	dayRaw: string | null,
	tzOffsetMin: number = 0
): Promise<WipTimelineData> {
	await connectDB();
	const { day, dayStartMs } = parseDayParam(dayRaw, tzOffsetMin);
	const tasks = (await KanbanTask.find({}).lean()) as any[];
	return computeWipTimeline(tasks, dayStartMs, day);
}

