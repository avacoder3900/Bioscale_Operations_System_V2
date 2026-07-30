/**
 * KB2-05 — flow metrics. Computed on read from transitions[] + per-status
 * stamps (archived docs included); never stored as drift-prone fields.
 *
 * HARD CONSTRAINT — enforced here at the query layer, not as a UI convention:
 * nothing in this module returns per-person throughput, per-person cycle
 * time, leaderboards, or anything that trivially reconstructs them.
 * Measuring individual cycle time is the documented cause of cherry-picking
 * simple tasks — the exact disease this redesign exists to cure. The
 * pathology is diagnosed in the WORK (age, flow debt), not in people.
 * Per-person WIP counts are limits, not scores, and are allowed.
 */
import { connectDB, KanbanTask } from '$lib/server/db';
import { getKanbanPolicy } from './policy.js';
import type { KanbanBoard, KanbanSizeClass } from '$lib/shared/kanban-status';

const DAY = 86400000;
const MIN_SLE_SAMPLES = 8;

function percentile(sorted: number[], p: number): number | null {
	if (!sorted.length) return null;
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Cycle-time samples (days, wip → done) per size class, archived included. */
async function cycleTimeSamples(board: KanbanBoard) {
	const done = (await KanbanTask.find({
		board,
		status: 'done',
		wipDate: { $ne: null },
		completedDate: { $ne: null }
	})
		.select('sizeClass wipDate completedDate')
		.lean()) as any[];
	const byClass: Record<string, number[]> = { short: [], medium: [], long: [], all: [] };
	for (const t of done) {
		const d = (new Date(t.completedDate).getTime() - new Date(t.wipDate).getTime()) / DAY;
		if (d < 0) continue;
		byClass.all.push(d);
		(byClass[t.sizeClass ?? 'medium'] ??= []).push(d);
	}
	for (const k of Object.keys(byClass)) byClass[k].sort((a, b) => a - b);
	return byClass;
}

/**
 * SLE per size class: "N% of <class> items finish within D days." Empirical
 * once there is data; policy seed until then; "insufficient data" below the
 * minimum sample size — never a fabricated number.
 */
export async function sle(board: KanbanBoard = 'ops') {
	const policy = await getKanbanPolicy();
	const pct = policy?.sle?.percentile ?? 85;
	const samples = await cycleTimeSamples(board);
	const out: Record<string, { days: number | null; n: number; source: 'measured' | 'seed' | 'insufficient' }> = {};
	for (const sc of ['short', 'medium', 'long'] as KanbanSizeClass[]) {
		const arr = samples[sc] ?? [];
		if (arr.length >= MIN_SLE_SAMPLES) {
			out[sc] = { days: Math.ceil(percentile(arr, pct)!), n: arr.length, source: 'measured' };
		} else {
			const seed = policy?.sle?.perSizeClassDays?.[sc] ?? null;
			out[sc] = seed
				? { days: seed, n: arr.length, source: 'seed' }
				: { days: null, n: arr.length, source: 'insufficient' };
		}
	}
	return { percentile: pct, perSizeClass: out, minSamples: MIN_SLE_SAMPLES };
}

/**
 * Work Item Age — THE leading indicator, built first (KB2-05 §order).
 * age = now − first wip entry, for every unfinished Tier 2 item. Cycle time
 * only describes finished work; age shows what is quietly stuck NOW.
 * Flow debt = this item aged while items started after it reached done —
 * the measurable signature of cherry-picking, diagnosed in the work.
 */
export async function workItemAge(board: KanbanBoard = 'ops') {
	await connectDB();
	const now = Date.now();
	const sleData = await sle(board);

	const active = (await KanbanTask.find({
		board,
		status: { $in: ['wip', 'waiting', 'blocked', 'review'] },
		archived: false
	})
		.select('title status sizeClass classOfService itemType wipDate committedAt project blockedReason waitingOn waitingUntil rank')
		.lean()) as any[];

	// Overtaken-by set: done items whose wip started after each active item's start.
	const recentDone = (await KanbanTask.find({
		board,
		status: 'done',
		wipDate: { $ne: null },
		completedDate: { $gte: new Date(now - 30 * DAY) }
	})
		.select('wipDate')
		.lean()) as any[];

	const items = active.map((t) => {
		const start = t.wipDate ?? t.committedAt;
		const ageDays = start ? (now - new Date(start).getTime()) / DAY : null;
		const sleDays = sleData.perSizeClass[t.sizeClass ?? 'medium']?.days ?? null;
		const overtakenBy = start
			? recentDone.filter((d) => new Date(d.wipDate).getTime() > new Date(start).getTime()).length
			: 0;
		return {
			taskId: t._id,
			title: t.title,
			status: t.status,
			project: t.project?.name,
			sizeClass: t.sizeClass,
			classOfService: t.classOfService,
			ageDays: ageDays === null ? null : Math.round(ageDays * 10) / 10,
			sleDays,
			overSle: ageDays !== null && sleDays !== null && ageDays > sleDays,
			flowDebt: overtakenBy > 0 && ageDays !== null && sleDays !== null && ageDays > sleDays,
			overtakenBy,
			blockedReason: t.blockedReason,
			waitingOn: t.waitingOn
		};
	});
	items.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
	return { items, sle: sleData };
}

/** discovered ÷ all over committed items, rolling window. Reserves queue capacity honestly. */
export async function discoveredRatio(board: KanbanBoard = 'ops', windowDays = 30) {
	await connectDB();
	const since = new Date(Date.now() - windowDays * DAY);
	const committed = (await KanbanTask.find({ board, committedAt: { $gte: since } })
		.select('origin')
		.lean()) as any[];
	const discovered = committed.filter((t) => t.origin === 'discovered').length;
	const total = committed.length;
	return {
		windowDays,
		discovered,
		planned: total - discovered,
		ratioPct: total ? Math.round((discovered / total) * 100) : null,
		suggestion: total
			? `Fill ready to ~${100 - Math.round((discovered / total) * 100)}% of the cap; hold the rest open for discovered work.`
			: 'No committed items in the window yet.'
	};
}

/** Weekly done counts (throughput trend) + expedite share — aggregates, never per-person. */
export async function throughputAndExpedite(board: KanbanBoard = 'ops', weeks = 8) {
	await connectDB();
	const since = new Date(Date.now() - weeks * 7 * DAY);
	const done = (await KanbanTask.find({ board, status: 'done', completedDate: { $gte: since } })
		.select('completedDate classOfService')
		.lean()) as any[];
	const byWeek: Record<string, number> = {};
	for (const t of done) {
		const d = new Date(t.completedDate);
		const week = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
		byWeek[week] = (byWeek[week] ?? 0) + 1;
	}
	const committed30 = (await KanbanTask.find({ board, committedAt: { $gte: new Date(Date.now() - 30 * DAY) } })
		.select('classOfService')
		.lean()) as any[];
	const expedite = committed30.filter((t) => t.classOfService === 'expedite').length;
	const policy = await getKanbanPolicy();
	const alertPct = policy?.expedite?.alertPctRolling30d ?? 5;
	const expeditePct = committed30.length ? Math.round((expedite / committed30.length) * 1000) / 10 : 0;
	return {
		weeklyDone: Object.entries(byWeek).sort(([a], [b]) => a.localeCompare(b)).map(([week, n]) => ({ week, n })),
		expedite: {
			last30d: expedite,
			pctOfCommitted: expeditePct,
			alert: expeditePct > alertPct,
			note: expeditePct > alertPct ? 'Rising expedite rate is an upstream-planning signal, not a run of bad luck.' : undefined
		}
	};
}

/**
 * Flow efficiency: touch time ÷ total elapsed, from waiting/blocked intervals
 * in transitions[]. Diagnostic and protective — it distinguishes "slow" from
 * "sat in waiting nine days"; blocked time is a SYSTEM problem.
 */
export async function flowEfficiency(board: KanbanBoard = 'ops', windowDays = 60) {
	await connectDB();
	const since = new Date(Date.now() - windowDays * DAY);
	const done = (await KanbanTask.find({
		board,
		status: 'done',
		completedDate: { $gte: since },
		wipDate: { $ne: null }
	})
		.select('transitions wipDate completedDate')
		.lean()) as any[];

	let totalElapsed = 0;
	let totalParked = 0;
	for (const t of done) {
		const startMs = new Date(t.wipDate).getTime();
		const endMs = new Date(t.completedDate).getTime();
		if (endMs <= startMs) continue;
		totalElapsed += endMs - startMs;
		const trs = (t.transitions ?? []).sort(
			(a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
		);
		let parkedFrom: number | null = null;
		for (const tr of trs) {
			const ts = new Date(tr.timestamp).getTime();
			if (ts < startMs || ts > endMs) continue;
			if (['waiting', 'blocked'].includes(tr.toStatus) && parkedFrom === null) parkedFrom = ts;
			else if (!['waiting', 'blocked'].includes(tr.toStatus) && parkedFrom !== null) {
				totalParked += ts - parkedFrom;
				parkedFrom = null;
			}
		}
		if (parkedFrom !== null) totalParked += endMs - parkedFrom;
	}
	return {
		windowDays,
		n: done.length,
		efficiencyPct: totalElapsed ? Math.round(((totalElapsed - totalParked) / totalElapsed) * 100) : null,
		note: 'Low efficiency means items sit in waiting/blocked — a system problem, not a person problem.'
	};
}

/** The Flow view / MCP one-call. No people anywhere in this payload. */
export async function flowMetrics(board: KanbanBoard = 'ops') {
	const [age, ratio, throughput, efficiency] = await Promise.all([
		workItemAge(board),
		discoveredRatio(board),
		throughputAndExpedite(board),
		flowEfficiency(board)
	]);
	return { board, workItemAge: age, discoveredRatio: ratio, ...throughput, flowEfficiency: efficiency };
}
