/**
 * KB2-15 — the daily WIP timeline (who is working on what, 15-minute cells),
 * moved from the retired analytics.ts.
 *
 * DECISION-#12 BOUNDARY (KB2-00): "who is on what right now" is a coordination
 * view and is allowed — per-person WIP is a limit, not a score. What this
 * module must NEVER grow: per-person totals, done counts, cycle times, or any
 * rankable aggregate. If a change adds a number next to a person's name that
 * could go in a spreadsheet column, it doesn't belong here.
 *
 * Deliberately cross-board: one human, one limit, across both boards (KB2-04).
 * Lane count comes from KanbanPolicy.wipPerPerson — the old per-user
 * `user.wipLimit` field is retired.
 */
import { connectDB, KanbanTask } from '$lib/server/db';
import { getKanbanPolicy } from './policy.js';

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
export function parseDayParam(
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

function assignLanes(segments: WipSegment[], wipLimit: number): WipLane[] {
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

async function computeWipTimeline(
	allTasks: any[],
	dayStartMs: number,
	day: string
): Promise<WipTimelineData> {
	const dayEndMs = dayStartMs + 24 * 3600_000;
	const now = Date.now();

	// One shared lane count for everyone: the policy WIP limit (KB2-04).
	const policy = await getKanbanPolicy();
	const wipPerPerson: number = policy?.wipPerPerson ?? 2;

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

	const people: WipTimelinePerson[] = [];
	for (const [key, acc] of byAssignee.entries()) {
		const wipLimit = key === '__unassigned__' ? 0 : wipPerPerson;
		people.push({
			userId: key,
			username: acc.username,
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

/** Load the WIP timeline for a day. Cross-board on purpose — see module header. */
export async function loadWipTimeline(
	dayRaw: string | null,
	tzOffsetMin: number = 0
): Promise<WipTimelineData> {
	await connectDB();
	const { day, dayStartMs } = parseDayParam(dayRaw, tzOffsetMin);
	const tasks = (await KanbanTask.find({}).lean()) as any[];
	return computeWipTimeline(tasks, dayStartMs, day);
}
