/**
 * KB2-28 — the roadmap scheduler: CPM backward/forward pass over the
 * `blocked_by` graph, anchored to milestone dueDates, plus Goldratt's
 * capacity clamp. Dates are OUTPUTS, never inputs; nothing here is ever
 * written back to task documents (derived and anchored dates never mix).
 * Recomputed fresh on every call — no stored schedule, nothing to go stale.
 *
 * Estimate ladder (KB2-27): explicit estimateDays → SIZE_CLASS_DAYS →
 * historical median cycle time. The math never stalls on a missing estimate,
 * and every number reports which rung it came from.
 *
 * All arithmetic is in business days (weekends excluded, no holiday calendar
 * in v1). Per KB2-00 decision #12 there is nothing per-person here — the
 * capacity clamp models ONE team-wide pipe from aggregate throughput.
 */
import { connectDB, KanbanTask } from '$lib/server/db';
import { getKanbanPolicy } from './policy.js';
import { SIZE_CLASS_DAYS, type KanbanSizeClass } from '$lib/shared/kanban-status';

// ---------------------------------------------------------------- types

export type EstimateSource = 'explicit' | 'sizeClass' | 'median';

export interface ScheduledTask {
	id: string;
	trackingNumber: string | null;
	title: string;
	status: string;
	rank: number;
	tags: string[];
	itemType: string;
	done: boolean;
	durationDays: number;
	estimateSource: EstimateSource;
	/** Derived dates (ISO, business-day arithmetic). Null for done tasks' LS/LF. */
	earlyStart: string | null;
	earlyFinish: string | null;
	lateStart: string | null;
	lateFinish: string | null;
	slackDays: number | null;
	onCriticalChain: boolean;
	late: boolean; // lateStart < today
	blockedByOpen: string[]; // not-done blocker ids
	/** KB2-30: ALL in-subgraph predecessors (incl. done) — the canvas draws edges from these. */
	blockedBy: string[];
	/** KB2-31: hands-on effort (working days) when it differs from duration; null = same. */
	effortDays: number | null;
}

/** KB2-31 — how the effective velocity was chosen. */
export type VelocitySource = 'policy' | 'blend' | 'measured';

export interface CapacityPeriod {
	from: string; // ISO date; first period starts today
	teamEstDaysPerWeek: number;
}

/** KB2-31 — non-persisted what-if inputs (kanban_roadmap overrides). */
export interface CapacityOverrides {
	capacityOverride?: number;
	scheduleOverride?: { from: string; teamEstDaysPerWeek: number }[];
}

export interface MustStartRow {
	id: string;
	trackingNumber: string | null;
	title: string;
	status: string;
	rank: number;
	slackDays: number;
	lateStart: string;
	late: boolean; // red: latest start already passed
	milestoneId: string;
	milestoneTitle: string;
}

export interface MilestoneSchedule {
	id: string;
	trackingNumber: string | null;
	title: string;
	dueDate: string;
	daysLeft: number; // business days from today to dueDate
	tasks: ScheduledTask[];
	/** max(forward-pass finish, capacity clamp). ISO date. */
	projectedFinish: string;
	cpmFinish: string;
	clampFinish: string | null; // null when velocity unknown
	bufferDays: number; // dueDate − projectedFinish (business days; negative = infeasible)
	feasible: boolean;
	chainPctByCount: number; // 0..1 done fraction
	chainPctByDays: number;
	remainingDays: number;
	mustStart: MustStartRow[];
	cycleError: string | null; // dependency cycle detected — data error, not scheduled
}

export interface RoadmapResult {
	generatedAt: string;
	milestones: MilestoneSchedule[];
	/** Milestones with no dueDate — flagged, not scheduled. */
	unscheduledMilestones: { id: string; title: string; trackingNumber: string | null }[];
	/** EFFECTIVE velocity the clamp used (est-days/week); null = clamp disabled. */
	velocityDaysPerWeek: number | null;
	/** KB2-31: what the board actually measured (trailing window when the knob is set, legacy 8-wk mean otherwise). */
	measuredVelocityDaysPerWeek: number | null;
	/** KB2-31: where the effective velocity came from. */
	velocitySource: VelocitySource;
	/** KB2-31: estimated completions in the trailing window (drives the blend). */
	velocitySampleN: number;
	/** KB2-31: the piecewise capacity schedule the clamp walked (resolved from policy/overrides). */
	resolvedCapacitySchedule: CapacityPeriod[] | null;
	medianCycleDays: number; // ladder rung 3
	calibration: { n: number; medianActualOverEstimate: number | null };
}

// ---------------------------------------------------------------- business-day math

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): Date {
	const x = new Date(d);
	x.setHours(0, 0, 0, 0);
	return x;
}

function isWeekend(d: Date): boolean {
	const w = d.getDay();
	return w === 0 || w === 6;
}

/** Parse a date that may be a YYYY-MM-DD string (treat as LOCAL midnight, not UTC) or a Date. */
export function parseLocalDate(v: string | Date): Date {
	if (v instanceof Date) return v;
	return /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T00:00:00') : new Date(v);
}

/** Add n business days (n may be fractional; fraction applied on the final day). */
export function addBusinessDays(from: Date, n: number): Date {
	let d = startOfDay(from);
	// normalize start to a business day (roll forward)
	while (isWeekend(d)) d = new Date(d.getTime() + DAY_MS);
	const sign = n >= 0 ? 1 : -1;
	let whole = Math.floor(Math.abs(n));
	const frac = Math.abs(n) - whole;
	while (whole > 0) {
		d = new Date(d.getTime() + sign * DAY_MS);
		if (!isWeekend(d)) whole--;
	}
	if (frac > 0) {
		let e = new Date(d.getTime() + sign * DAY_MS);
		while (isWeekend(e)) e = new Date(e.getTime() + sign * DAY_MS);
		d = new Date(d.getTime() + (e.getTime() - d.getTime()) * frac);
	}
	return d;
}

/** Business days between two dates (signed, b − a). */
export function businessDaysBetween(a: Date, b: Date): number {
	let from = startOfDay(a);
	let to = startOfDay(b);
	const sign = to >= from ? 1 : -1;
	if (sign < 0) [from, to] = [to, from];
	let n = 0;
	let d = from;
	while (d < to) {
		d = new Date(d.getTime() + DAY_MS);
		if (!isWeekend(d)) n++;
	}
	return sign * n;
}

// ---------------------------------------------------------------- core

const iso = (d: Date | null): string | null => (d ? startOfDay(d).toISOString().slice(0, 10) : null);

function effectiveDuration(
	t: any,
	medianCycleDays: number
): { days: number; source: EstimateSource } {
	if (t.itemType === 'milestone') return { days: 0, source: 'explicit' };
	if (typeof t.estimateDays === 'number' && t.estimateDays > 0)
		return { days: t.estimateDays, source: 'explicit' };
	if (t.sizeClass && (SIZE_CLASS_DAYS as any)[t.sizeClass] != null)
		return { days: SIZE_CLASS_DAYS[t.sizeClass as KanbanSizeClass], source: 'sizeClass' };
	return { days: medianCycleDays, source: 'median' };
}

/**
 * KB2-31 — hands-on effort for the capacity clamp / velocity / calibration:
 * effortDays ?? duration ladder. Duration stays what CPM walks; effort is what
 * the team's week actually spends.
 */
function effectiveEffort(t: any, medianCycleDays: number): number {
	if (typeof t.effortDays === 'number' && t.effortDays > 0) return t.effortDays;
	return effectiveDuration(t, medianCycleDays).days;
}

function median(xs: number[]): number | null {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The whole roadmap: every dated milestone scheduled, plus global calibration.
 * `overrides` (KB2-31/32) are what-ifs for THIS computation only — never persisted.
 */
export async function computeRoadmap(
	now = new Date(),
	overrides: CapacityOverrides = {}
): Promise<RoadmapResult> {
	await connectDB();
	const today = startOfDay(now);
	const policy: any = await getKanbanPolicy().catch(() => null);
	const cap = policy?.capacity ?? {};
	const blendMinN: number = cap.blendMinN ?? 8;
	const measuredMinN: number = cap.measuredMinN ?? 15;
	const trailingWindowWeeks: number = cap.trailingWindowWeeks ?? 6;
	const knob: number | null =
		typeof overrides.capacityOverride === 'number' && overrides.capacityOverride > 0
			? overrides.capacityOverride
			: typeof cap.teamEstDaysPerWeek === 'number' && cap.teamEstDaysPerWeek > 0
				? cap.teamEstDaysPerWeek
				: null;

	const all = (await KanbanTask.find({ archived: false })
		.select(
			'_id trackingNumber title status rank tags itemType sizeClass estimateDays effortDays dueDate links wipDate completedDate'
		)
		.lean()) as any[];
	// Recently archived done tasks still count for history/velocity:
	const doneHistory = (await KanbanTask.find({
		status: 'done',
		completedDate: { $gte: new Date(today.getTime() - 91 * DAY_MS) }
	})
		.select('_id sizeClass estimateDays effortDays wipDate completedDate')
		.lean()) as any[];

	// --- ladder rung 3: median actual cycle time (wip → done, business days) ---
	const cycles = doneHistory
		.filter((t) => t.wipDate && t.completedDate)
		.map((t) => Math.max(0.5, businessDaysBetween(new Date(t.wipDate), new Date(t.completedDate))));
	// Floor at 1: batch-recorded same-day wip→done flips would otherwise make
	// the default duration for unsized future work absurdly optimistic.
	const medianCycleDays = Math.max(1, median(cycles) ?? 3);

	// --- calibration: actual vs the SAME field the clamp consumes (KB2-31:
	// effortDays ?? estimateDays) — else elapsed tasks poison calibration
	// exactly as they poison velocity ---
	const explicitEst = (t: any): number | null =>
		typeof t.effortDays === 'number' && t.effortDays > 0
			? t.effortDays
			: typeof t.estimateDays === 'number' && t.estimateDays > 0
				? t.estimateDays
				: null;
	const ratios = doneHistory
		.filter((t) => t.wipDate && t.completedDate && explicitEst(t) !== null)
		.map(
			(t) =>
				Math.max(0.5, businessDaysBetween(new Date(t.wipDate), new Date(t.completedDate))) /
				explicitEst(t)!
		);
	const calibration = { n: ratios.length, medianActualOverEstimate: median(ratios) };

	// --- measured velocity (KB2-31) ---
	// Legacy (no knob): mean weekly LADDER days over 8 weeks — unchanged from
	// KB2-28 so acceptance #5 holds (numbers identical when capacity is unset).
	// Knob set: TRAILING window (trailingWindowWeeks) valued over
	// effortDays ?? estimateDays for estimated tasks (ladder for the rest) so
	// the pre-team era ages out and elapsed tasks stop inflating.
	const sumWindow = (weeks: number, valueOf: (t: any) => number): number => {
		let total = 0;
		for (const t of doneHistory) {
			if (!t.completedDate) continue;
			const weeksAgo = Math.floor(
				(today.getTime() - startOfDay(new Date(t.completedDate)).getTime()) / (7 * DAY_MS)
			);
			if (weeksAgo < 0 || weeksAgo >= weeks) continue;
			total += valueOf(t);
		}
		return total;
	};
	const legacyTotal = sumWindow(8, (t) => effectiveDuration(t, medianCycleDays).days);
	const legacyVelocity = legacyTotal > 0 ? legacyTotal / 8 : null;
	const trailingTotal = sumWindow(trailingWindowWeeks, (t) => effectiveEffort(t, medianCycleDays));
	const trailingVelocity = trailingTotal > 0 ? trailingTotal / trailingWindowWeeks : null;
	// n = estimated completions in the trailing window (the blend driver).
	let velocitySampleN = 0;
	for (const t of doneHistory) {
		if (!t.completedDate || explicitEst(t) === null) continue;
		const weeksAgo = Math.floor(
			(today.getTime() - startOfDay(new Date(t.completedDate)).getTime()) / (7 * DAY_MS)
		);
		if (weeksAgo >= 0 && weeksAgo < trailingWindowWeeks) velocitySampleN++;
	}

	let velocitySource: VelocitySource;
	let velocityDaysPerWeek: number | null;
	let measuredVelocityDaysPerWeek: number | null;
	if (knob === null) {
		// Legacy behavior, byte-for-byte on the numbers.
		velocitySource = 'measured';
		velocityDaysPerWeek = legacyVelocity;
		measuredVelocityDaysPerWeek = legacyVelocity;
	} else if (velocitySampleN >= measuredMinN && trailingVelocity !== null) {
		velocitySource = 'measured';
		velocityDaysPerWeek = trailingVelocity;
		measuredVelocityDaysPerWeek = trailingVelocity;
	} else if (velocitySampleN >= blendMinN && trailingVelocity !== null) {
		velocitySource = 'blend';
		const w = velocitySampleN / measuredMinN;
		velocityDaysPerWeek = trailingVelocity * w + knob * (1 - w);
		measuredVelocityDaysPerWeek = trailingVelocity;
	} else {
		velocitySource = 'policy';
		velocityDaysPerWeek = knob;
		measuredVelocityDaysPerWeek = trailingVelocity;
	}

	// --- capacity schedule (KB2-31 #3): piecewise rates from today ---
	const rawSchedule: any[] =
		overrides.scheduleOverride ??
		(overrides.capacityOverride != null ? [] : (cap.schedule ?? []));
	const schedulePeriods: CapacityPeriod[] | null = velocityDaysPerWeek
		? [
				{ from: iso(today)!, teamEstDaysPerWeek: velocityDaysPerWeek },
				...rawSchedule
					.filter(
						(e: any) =>
							e && e.from && typeof e.teamEstDaysPerWeek === 'number' && e.teamEstDaysPerWeek > 0 &&
							startOfDay(parseLocalDate(e.from)) > today
					)
					.map((e: any) => ({
						from: iso(startOfDay(parseLocalDate(e.from)))!,
						teamEstDaysPerWeek: e.teamEstDaysPerWeek
					}))
					.sort((a: CapacityPeriod, b: CapacityPeriod) => a.from.localeCompare(b.from))
			]
		: null;

	/** Walk the piecewise schedule consuming `remaining` effort-days → finish date. */
	const clampWalk = (remaining: number): Date | null => {
		if (!schedulePeriods || remaining <= 0) return null;
		let cursor = new Date(today);
		let left = remaining;
		for (let i = 0; i < schedulePeriods.length; i++) {
			const rate = schedulePeriods[i].teamEstDaysPerWeek;
			const end = i + 1 < schedulePeriods.length ? startOfDay(parseLocalDate(schedulePeriods[i + 1].from)) : null;
			const weeksAvail = end ? (end.getTime() - cursor.getTime()) / (7 * DAY_MS) : Infinity;
			const weeksNeeded = left / rate;
			if (weeksNeeded <= weeksAvail) {
				return addBusinessDays(cursor, weeksNeeded * 5);
			}
			left -= weeksAvail * rate;
			cursor = end!;
		}
		return null; // unreachable (last period is unbounded)
	};

	// --- graph: normalized blocking edges (pred → succ) ---
	const byId = new Map(all.map((t) => [String(t._id), t]));
	const preds = new Map<string, Set<string>>(); // succ → set of pred ids
	const succs = new Map<string, Set<string>>();
	const addEdge = (pred: string, succ: string) => {
		if (!byId.has(pred) || !byId.has(succ) || pred === succ) return;
		if (!preds.has(succ)) preds.set(succ, new Set());
		if (!succs.has(pred)) succs.set(pred, new Set());
		preds.get(succ)!.add(pred);
		succs.get(pred)!.add(succ);
	};
	for (const t of all) {
		for (const l of t.links ?? []) {
			if (l.type === 'blocked_by') addEdge(String(l.taskId), String(t._id));
			else if (l.type === 'blocks') addEdge(String(t._id), String(l.taskId));
		}
	}

	const milestonesAll = all.filter((t) => t.itemType === 'milestone' && t.status !== 'done');
	const unscheduledMilestones = milestonesAll
		.filter((m) => !m.dueDate)
		.map((m) => ({ id: String(m._id), title: m.title, trackingNumber: m.trackingNumber ?? null }));

	const milestones: MilestoneSchedule[] = [];

	for (const m of milestonesAll.filter((x) => x.dueDate)) {
		const mid = String(m._id);
		const due = startOfDay(new Date(m.dueDate));

		// Ancestor subgraph (everything feeding the milestone), incl. the milestone.
		const inSet = new Set<string>([mid]);
		const stack = [mid];
		while (stack.length) {
			const cur = stack.pop()!;
			for (const p of preds.get(cur) ?? []) if (!inSet.has(p)) { inSet.add(p); stack.push(p); }
		}

		// Topological order (Kahn) within the subgraph; cycle → data error.
		const indeg = new Map<string, number>();
		for (const id of inSet) {
			let n = 0;
			for (const p of preds.get(id) ?? []) if (inSet.has(p)) n++;
			indeg.set(id, n);
		}
		const topo: string[] = [];
		const q = [...inSet].filter((id) => indeg.get(id) === 0);
		while (q.length) {
			const cur = q.shift()!;
			topo.push(cur);
			for (const s of succs.get(cur) ?? []) {
				if (!inSet.has(s)) continue;
				indeg.set(s, indeg.get(s)! - 1);
				if (indeg.get(s) === 0) q.push(s);
			}
		}
		const cycleError =
			topo.length !== inSet.size
				? `Dependency cycle among: ${[...inSet].filter((id) => !topo.includes(id)).map((id) => byId.get(id)?.trackingNumber ?? id).join(', ')} — fix the links; these tasks are excluded from scheduling.`
				: null;

		const dur = new Map<string, { days: number; source: EstimateSource }>();
		for (const id of topo) dur.set(id, effectiveDuration(byId.get(id), medianCycleDays));
		const isDone = (id: string) => byId.get(id).status === 'done';

		// Backward pass (LF/LS) — reverse topo, anchored at the milestone due date.
		const LF = new Map<string, Date>();
		const LS = new Map<string, Date>();
		for (const id of [...topo].reverse()) {
			let lf: Date;
			if (id === mid) lf = due;
			else {
				const succDates = [...(succs.get(id) ?? [])]
					.filter((s) => inSet.has(s) && LS.has(s))
					.map((s) => LS.get(s)!);
				lf = succDates.length ? new Date(Math.min(...succDates.map((d) => d.getTime()))) : due;
			}
			LF.set(id, lf);
			LS.set(id, addBusinessDays(lf, -dur.get(id)!.days));
		}

		// Forward pass (ES/EF) from today over not-done tasks; done preds
		// contribute their completion date.
		const ES = new Map<string, Date>();
		const EF = new Map<string, Date>();
		for (const id of topo) {
			if (isDone(id)) {
				const t = byId.get(id);
				const fin = t.completedDate ? startOfDay(new Date(t.completedDate)) : today;
				ES.set(id, fin);
				EF.set(id, fin);
				continue;
			}
			const predFins = [...(preds.get(id) ?? [])]
				.filter((p) => inSet.has(p) && EF.has(p))
				.map((p) => EF.get(p)!);
			const es = new Date(Math.max(today.getTime(), ...predFins.map((d) => d.getTime())));
			ES.set(id, es);
			EF.set(id, addBusinessDays(es, dur.get(id)!.days));
		}

		const cpmFinishDate = EF.get(mid) ?? today;

		// Capacity clamp: one team-wide pipe. KB2-31: workload = EFFORT
		// (effortDays ?? duration), walked through the piecewise schedule.
		const remainingDays = topo
			.filter((id) => !isDone(id))
			.reduce((s, id) => s + effectiveEffort(byId.get(id), medianCycleDays), 0);
		const clampFinishDate: Date | null = clampWalk(remainingDays);
		const projectedFinishDate =
			clampFinishDate && clampFinishDate > cpmFinishDate ? clampFinishDate : cpmFinishDate;

		const bufferDays = businessDaysBetween(projectedFinishDate, due);

		// Critical chain = min-slack among not-done tasks.
		const slackOf = (id: string) => businessDaysBetween(ES.get(id)!, LS.get(id)!);
		const notDone = topo.filter((id) => !isDone(id) && id !== mid);
		const minSlack = notDone.length ? Math.min(...notDone.map(slackOf)) : 0;

		const tasks: ScheduledTask[] = topo.map((id) => {
			const t = byId.get(id);
			const done = isDone(id);
			const allPreds = [...(preds.get(id) ?? [])].filter((p) => inSet.has(p));
			const blockedByOpen = allPreds.filter((p) => !isDone(p));
			const slack = done ? null : slackOf(id);
			return {
				id,
				trackingNumber: t.trackingNumber ?? null,
				title: t.title,
				status: t.status,
				rank: t.rank ?? 0,
				tags: t.tags ?? [],
				itemType: t.itemType ?? 'deliverable',
				done,
				durationDays: dur.get(id)!.days,
				estimateSource: dur.get(id)!.source,
				earlyStart: iso(ES.get(id) ?? null),
				earlyFinish: iso(EF.get(id) ?? null),
				lateStart: done ? null : iso(LS.get(id)!),
				lateFinish: done ? null : iso(LF.get(id)!),
				slackDays: slack,
				onCriticalChain: !done && id !== mid && slack === minSlack,
				late: !done && id !== mid && LS.get(id)! < today,
				blockedByOpen,
				blockedBy: allPreds,
				effortDays: typeof t.effortDays === 'number' && t.effortDays > 0 ? t.effortDays : null
			};
		});

		// Must-start: not-done, unblocked, LS within a week (or past). Slack asc,
		// Tier 1 rank tiebreak (rank = importance, slack = urgency).
		const weekOut = addBusinessDays(today, 5);
		const mustStart: MustStartRow[] = tasks
			.filter(
				(t) =>
					!t.done &&
					t.id !== mid &&
					t.blockedByOpen.length === 0 &&
					!['wip', 'review', 'waiting'].includes(t.status) &&
					new Date(t.lateStart!) <= weekOut
			)
			.sort((a, b) => (a.slackDays! - b.slackDays!) || (a.rank - b.rank))
			.map((t) => ({
				id: t.id,
				trackingNumber: t.trackingNumber,
				title: t.title,
				status: t.status,
				rank: t.rank,
				slackDays: t.slackDays!,
				lateStart: t.lateStart!,
				late: t.late,
				milestoneId: mid,
				milestoneTitle: m.title
			}));

		const doneCount = topo.filter(isDone).length;
		const totalDays = topo.reduce((s, id) => s + dur.get(id)!.days, 0);

		milestones.push({
			id: mid,
			trackingNumber: m.trackingNumber ?? null,
			title: m.title,
			dueDate: iso(due)!,
			daysLeft: businessDaysBetween(today, due),
			tasks,
			projectedFinish: iso(projectedFinishDate)!,
			cpmFinish: iso(cpmFinishDate)!,
			clampFinish: iso(clampFinishDate),
			bufferDays,
			feasible: bufferDays >= 0,
			chainPctByCount: topo.length > 1 ? doneCount / (topo.length - 1) : 0,
			chainPctByDays: totalDays > 0 ? (totalDays - remainingDays) / totalDays : 0,
			remainingDays,
			mustStart,
			cycleError
		});
	}

	milestones.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

	return {
		generatedAt: now.toISOString(),
		milestones,
		unscheduledMilestones,
		velocityDaysPerWeek,
		measuredVelocityDaysPerWeek,
		velocitySource,
		velocitySampleN,
		resolvedCapacitySchedule: schedulePeriods,
		medianCycleDays,
		calibration
	};
}
