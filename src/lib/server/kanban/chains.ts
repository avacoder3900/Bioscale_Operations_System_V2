/**
 * KB2-39 — chains: the unit of processing.
 *
 * A chain is a milestone's dependency DAG — the milestone plus everything that
 * transitively blocks it via blocks/blocked_by links. Branches are normal.
 * Chains are DERIVED per call from links[] (never stored), named by their
 * milestone, dated by its dueDate, and linked to the PlanningDocument that
 * workshopped them (plan.milestoneId).
 *
 * One source for every surface: Tier 1 badges/grouping, roadmap bands, the
 * task page, the plans pages, and the MCP board snapshot.
 */
import { connectDB, KanbanTask, PlanningDocument } from '$lib/server/db';

export interface ChainSummary {
	/** Milestone task id, or `unanchored:<terminalTaskId>`. */
	id: string;
	kind: 'milestone' | 'unanchored';
	name: string;
	trackingNumber: string | null;
	/** ISO yyyy-mm-dd, milestone chains only. */
	dueDate: string | null;
	milestoneStatus: string | null;
	planId: string | null;
	planTitle: string | null;
	/** Task ids in dependency order (topological, rank tiebreak). Excludes the milestone itself. */
	order: string[];
	total: number;
	done: number;
	/** ready/wip/waiting/blocked/review — committed and moving. */
	board: number;
	/** captured/processed/icebox — still upstream. */
	tier1: number;
	/** Not done, every blocker done — the startable front of the chain. */
	nextUp: string[];
}

export interface TaskChainRef {
	chainId: string;
	chainName: string;
	kind: 'milestone' | 'unanchored';
	dueDate: string | null;
	/** 1-based slot in the chain's dependency order. */
	position: number;
	total: number;
	nextUp: boolean;
	/** Open tasks that must finish before this one (transitive). */
	behind: number;
	/** Other chain ids this task also belongs to. */
	also: string[];
}

export interface ChainsResult {
	chains: ChainSummary[];
	byTask: Record<string, TaskChainRef>;
	generatedAt: string;
}

const BOARD_OPEN = new Set(['ready', 'wip', 'waiting', 'blocked', 'review']);
const TIER1 = new Set(['captured', 'processed', 'icebox']);

const isoDate = (d: unknown): string | null => {
	if (!d) return null;
	const dt = new Date(d as any);
	return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
};

/** "MILESTONE: Recipe lock — cortisol v1.0" → "Recipe lock — cortisol v1.0". */
export function chainDisplayName(title: string): string {
	return title.replace(/^\s*milestone\s*[:\-—]\s*/i, '').trim() || title;
}

export async function deriveChains(): Promise<ChainsResult> {
	await connectDB();
	const rows = (await KanbanTask.find({ archived: false, status: { $ne: 'declined' } })
		.select('_id trackingNumber title status itemType dueDate rank links')
		.lean()) as any[];

	const byId = new Map<string, any>(rows.map((t) => [String(t._id), t]));
	// blocker → blocked
	const preds = new Map<string, Set<string>>();
	const succs = new Map<string, Set<string>>();
	const addEdge = (blocker: string, blocked: string) => {
		if (blocker === blocked || !byId.has(blocker) || !byId.has(blocked)) return;
		(preds.get(blocked) ?? preds.set(blocked, new Set()).get(blocked)!).add(blocker);
		(succs.get(blocker) ?? succs.set(blocker, new Set()).get(blocker)!).add(blocked);
	};
	for (const t of rows) {
		const id = String(t._id);
		for (const l of t.links ?? []) {
			if (l.type === 'blocked_by') addEdge(String(l.taskId), id);
			else if (l.type === 'blocks') addEdge(id, String(l.taskId));
		}
	}

	const isDone = (id: string) => byId.get(id)?.status === 'done';

	// Transitive open ancestors per task (memoized DFS; cycles guarded by the
	// link service, but we still tolerate them here).
	const openAncestorsMemo = new Map<string, Set<string>>();
	const openAncestors = (id: string, stack = new Set<string>()): Set<string> => {
		const hit = openAncestorsMemo.get(id);
		if (hit) return hit;
		if (stack.has(id)) return new Set();
		stack.add(id);
		const out = new Set<string>();
		for (const p of preds.get(id) ?? []) {
			if (!isDone(p)) out.add(p);
			for (const a of openAncestors(p, stack)) out.add(a);
		}
		stack.delete(id);
		openAncestorsMemo.set(id, out);
		return out;
	};

	/** Topological order of `members` over restricted edges; rank then title as tiebreak. */
	const topo = (members: Set<string>): string[] => {
		const indeg = new Map<string, number>();
		for (const id of members) {
			let n = 0;
			for (const p of preds.get(id) ?? []) if (members.has(p)) n++;
			indeg.set(id, n);
		}
		const cmp = (a: string, b: string) => {
			const ta = byId.get(a), tb = byId.get(b);
			return (ta.rank ?? 0) - (tb.rank ?? 0) || String(ta.title).localeCompare(String(tb.title));
		};
		const ready = [...members].filter((id) => indeg.get(id) === 0).sort(cmp);
		const out: string[] = [];
		const seen = new Set<string>();
		while (ready.length) {
			const id = ready.shift()!;
			if (seen.has(id)) continue;
			seen.add(id);
			out.push(id);
			const next: string[] = [];
			for (const s of succs.get(id) ?? []) {
				if (!members.has(s)) continue;
				indeg.set(s, (indeg.get(s) ?? 1) - 1);
				if (indeg.get(s) === 0) next.push(s);
			}
			ready.push(...next.sort(cmp));
			ready.sort(cmp);
		}
		// Anything left (cycle) appended by rank so it is never lost.
		for (const id of [...members].filter((m) => !seen.has(m)).sort(cmp)) out.push(id);
		return out;
	};

	// ---- milestone chains -------------------------------------------------
	const milestones = rows.filter((t) => t.itemType === 'milestone');
	const milestoneIds = milestones.map((m) => String(m._id));
	const plans = milestoneIds.length
		? ((await PlanningDocument.find({ status: 'active', milestoneId: { $in: milestoneIds } })
				.select('_id title milestoneId')
				.lean()) as any[])
		: [];
	const planByMilestone = new Map(plans.map((p) => [String(p.milestoneId), p]));

	const membership = new Map<string, string[]>(); // taskId → chain ids
	const chains: ChainSummary[] = [];
	const ancestorsOf = (mid: string): Set<string> => {
		const out = new Set<string>();
		const stack = [mid];
		while (stack.length) {
			const cur = stack.pop()!;
			for (const p of preds.get(cur) ?? []) {
				if (out.has(p) || p === mid) continue;
				out.add(p);
				stack.push(p);
			}
		}
		return out;
	};

	const summarize = (
		id: string,
		kind: ChainSummary['kind'],
		name: string,
		trackingNumber: string | null,
		dueDate: string | null,
		milestoneStatus: string | null,
		members: Set<string>
	): ChainSummary => {
		const order = topo(members);
		let done = 0, board = 0, tier1 = 0;
		const nextUp: string[] = [];
		for (const tid of order) {
			const st = byId.get(tid)?.status;
			if (st === 'done') done++;
			else if (BOARD_OPEN.has(st)) board++;
			else if (TIER1.has(st)) tier1++;
			if (st !== 'done' && openAncestors(tid).size === 0) nextUp.push(tid);
			(membership.get(tid) ?? membership.set(tid, []).get(tid)!).push(id);
		}
		const plan = kind === 'milestone' ? planByMilestone.get(id) : undefined;
		return {
			id, kind, name, trackingNumber, dueDate, milestoneStatus,
			planId: plan ? String(plan._id) : null,
			planTitle: plan ? plan.title : null,
			order, total: order.length, done, board, tier1, nextUp
		};
	};

	for (const m of milestones) {
		const mid = String(m._id);
		chains.push(
			summarize(mid, 'milestone', chainDisplayName(m.title), m.trackingNumber ?? null, isoDate(m.dueDate), m.status, ancestorsOf(mid))
		);
	}

	// ---- unanchored chains: wired components with no milestone downstream ----
	const inMilestone = new Set(membership.keys());
	const wired = rows
		.map((t) => String(t._id))
		.filter((id) => !inMilestone.has(id) && byId.get(id).itemType !== 'milestone' && ((preds.get(id)?.size ?? 0) + (succs.get(id)?.size ?? 0)) > 0);
	const parent = new Map<string, string>(wired.map((id) => [id, id]));
	const find = (x: string): string => {
		let r = x;
		while (parent.get(r) !== r) r = parent.get(r)!;
		let c = x;
		while (parent.get(c) !== c) { const n = parent.get(c)!; parent.set(c, r); c = n; }
		return r;
	};
	for (const id of wired) {
		for (const n of [...(preds.get(id) ?? []), ...(succs.get(id) ?? [])]) {
			if (parent.has(n)) parent.set(find(id), find(n));
		}
	}
	const comps = new Map<string, Set<string>>();
	for (const id of wired) (comps.get(find(id)) ?? comps.set(find(id), new Set()).get(find(id))!).add(id);
	const unanchored: ChainSummary[] = [];
	for (const members of comps.values()) {
		if (members.size < 2) continue;
		// Terminal = no successor inside the component; best-ranked terminal names it.
		const terminals = [...members].filter((id) => ![...(succs.get(id) ?? [])].some((s) => members.has(s)));
		const named = (terminals.length ? terminals : [...members]).sort(
			(a, b) => (byId.get(a).rank ?? 0) - (byId.get(b).rank ?? 0)
		)[0];
		const t = byId.get(named);
		unanchored.push(summarize(`unanchored:${named}`, 'unanchored', `→ ${t.title}`, t.trackingNumber ?? null, null, null, members));
	}

	// ---- sort: dated milestones by due, undated milestones, then unanchored by size ----
	chains.sort((a, b) => {
		if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate) || a.total - b.total;
		if (a.dueDate) return -1;
		if (b.dueDate) return 1;
		return a.total - b.total;
	});
	unanchored.sort((a, b) => b.total - a.total);
	const all = [...chains, ...unanchored];
	const chainById = new Map(all.map((c) => [c.id, c]));

	// ---- primary chain per task + ref -------------------------------------
	const byTask: Record<string, TaskChainRef> = {};
	for (const [tid, ids] of membership) {
		const ordered = [...ids].sort((a, b) => all.findIndex((c) => c.id === a) - all.findIndex((c) => c.id === b));
		const primary = chainById.get(ordered[0])!;
		byTask[tid] = {
			chainId: primary.id,
			chainName: primary.name,
			kind: primary.kind,
			dueDate: primary.dueDate,
			position: primary.order.indexOf(tid) + 1,
			total: primary.total,
			nextUp: primary.nextUp.includes(tid),
			behind: openAncestors(tid).size,
			also: ordered.slice(1)
		};
	}

	return { chains: all, byTask, generatedAt: new Date().toISOString() };
}
