<script lang="ts">
	/**
	 * KB2-30/34/35 — the infinite-zoom dependency canvas.
	 *
	 *  · TIMELINE (default) — x-axis IS time: cards at their capacity-sequenced
	 *    plannedStart, milestones at their due date. Screen-space FLOATING AXIS
	 *    (months/weeks/today) pinned to the top and lane labels pinned left —
	 *    chronology and program always visible regardless of pan (KB2-35).
	 *  · FLOW — dagre structure over the wired graph; parked tasks in a packed
	 *    grid below it. Dragging pins positions (?/pinNode, shared layout).
	 *
	 *  PARKED tasks (KB2-34): open tasks wired into no milestone chain render
	 *  ghosted (dashed grey) — visible so gaps get spotted and wired on the
	 *  task page (KB2-33), scheduled behind chain work in the planned queue.
	 *
	 *  Focus mode (both): click a node → its chain stays lit, rest dims; Esc /
	 *  pane click clears. Esc order: focus → fullscreen.
	 */
	import { SvelteFlow, Background, Controls, MiniMap, ViewportPortal } from '@xyflow/svelte';
	import type { Node, Edge } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import dagre from '@dagrejs/dagre';
	import TaskNode from './TaskNode.svelte';
	import MilestoneNode from './MilestoneNode.svelte';
	import CanvasRefit from './CanvasRefit.svelte';
	import ViewportReporter from './ViewportReporter.svelte';
	import { tagColor } from '$lib/shared/tag-color';
	import { deserialize } from '$app/forms';
	import { page } from '$app/stores';
	import { get } from 'svelte/store';
	import { invalidateAll } from '$app/navigation';

	let {
		roadmap,
		pinned,
		chains = null,
		onnewmilestone = null
	}: {
		roadmap: any;
		pinned: { _id: string; x: number; y: number }[];
		/** KB2-39: deriveChains() result — bands group by primary chain, labeled + linked. */
		chains?: { chains: any[]; byTask: Record<string, any> } | null;
		/** Opens the page's new-milestone modal from the canvas toolbar (the strip above is gone). */
		onnewmilestone?: (() => void) | null;
	} = $props();

	const nodeTypes = { task: TaskNode, milestone: MilestoneNode };

	const TASK_W = 230, TASK_H = 64, MILE_W = 210, MILE_H = 104;
	// Cards grow until the WHOLE title fits — truncation makes the map useless
	// (Jacob, 2026-08-25). 22 chars/line is the worst tier's real budget (mid:
	// 14px font in ~186px; near: 12px next to the tracking number), measured
	// live after the first pass (30 chars) still ellipsized. The same height
	// feeds the node, the timeline row packing, and dagre, so nothing overlaps.
	const TITLE_LINE_CHARS = 22, TITLE_LINE_PX = 17, TITLE_MAX_LINES = 10;
	const titleLines = (t: any) =>
		Math.min(TITLE_MAX_LINES, Math.max(1, Math.ceil((t.title ?? '').length / TITLE_LINE_CHARS)));
	const heightOf = (t: any) => TASK_H + (titleLines(t) - 1) * TITLE_LINE_PX;
	const DAY_MS = 24 * 60 * 60 * 1000;
	const PX_PER_DAY = 26;
	const AXIS_H = 40; // floating axis strip height (screen px)

	let mode = $state<'timeline' | 'flow'>('timeline');
	let hideDone = $state(false);
	let fullscreen = $state(false);
	let focusId = $state<string | null>(null);
	// KB2-37 — click-to-connect: first click arms a port (left = the blocked
	// side, right = the blocker side); a complementary click on another node
	// creates the edge via ?/addEdge (cycle-guarded, audited) and the whole
	// roadmap recomputes + rearranges. Same-side click re-anchors; Esc / pane /
	// same-dot click cancels.
	let pendingPort = $state<{ id: string; side: 'left' | 'right'; label: string } | null>(null);
	let connectError = $state('');
	let connectBusy = $state(false);

	function labelOf(id: string): string {
		for (const m of roadmap.milestones) {
			if (m.id === id) return m.title.replace(/^MILESTONE:\s*/i, '');
			const t = m.tasks.find((x: any) => x.id === id);
			if (t) return t.trackingNumber ?? t.title.slice(0, 40);
		}
		const pk = (roadmap.parked ?? []).find((x: any) => x.id === id);
		return pk ? (pk.trackingNumber ?? pk.title.slice(0, 40)) : id.slice(0, 8);
	}

	async function onPort(id: string, side: 'left' | 'right') {
		connectError = '';
		if (connectBusy) return;
		if (!pendingPort) {
			pendingPort = { id, side, label: labelOf(id) };
			return;
		}
		if (pendingPort.id === id && pendingPort.side === side) { pendingPort = null; return; } // toggle off
		if (pendingPort.side === side) { pendingPort = { id, side, label: labelOf(id) }; return; } // re-anchor
		if (pendingPort.id === id) { connectError = 'A task cannot depend on itself.'; pendingPort = null; return; }
		// complementary sides on two nodes → blocker = the RIGHT end, blocked = the LEFT end
		const blockerId = side === 'right' ? id : pendingPort.id;
		const blockedId = side === 'left' ? id : pendingPort.id;
		connectBusy = true;
		try {
			const body = new FormData();
			body.set('blockerId', blockerId);
			body.set('blockedId', blockedId);
			const res = deserialize(await (await fetch('?/addEdge', { method: 'POST', body })).text());
			if (res.type === 'failure') {
				connectError = (res.data as any)?.error ?? 'Could not create the dependency';
			} else {
				// Success: recompute everything — bands, planned queue, slack,
				// buffers — the map rearranges around the new edge.
				await invalidateAll();
			}
		} catch {
			connectError = 'Could not create the dependency';
		} finally {
			connectBusy = false;
			pendingPort = null;
		}
	}
	let vp = $state({ x: 0, y: 0, zoom: 1 });
	// KB2-36 — tag filter (a LENS, not an axis): multi-select union, dims
	// non-matching tasks, persists in the URL (?tags=a,b) via replaceState.
	let tagFilter = $state(
		new Set(
			(get(page).url.searchParams.get('tags') ?? '')
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean)
		)
	);
	function toggleTag(tag: string) {
		if (tagFilter.has(tag)) tagFilter.delete(tag);
		else tagFilter.add(tag);
		tagFilter = new Set(tagFilter);
		const url = new URL(location.href);
		if (tagFilter.size) url.searchParams.set('tags', [...tagFilter].join(','));
		else url.searchParams.delete('tags');
		history.replaceState(history.state, '', url);
	}
	function clearTags() {
		tagFilter = new Set();
		const url = new URL(location.href);
		url.searchParams.delete('tags');
		history.replaceState(history.state, '', url);
	}
	// svelte-ignore state_referenced_locally — deliberate seed-once (drags own it after).
	let pinMap = $state(new Map(pinned.map((p) => [p._id, { x: p.x, y: p.y }])));

	// ---- graph model: dedupe chain tasks across milestone subgraphs (min slack
	// wins) + parked tasks (KB2-34)
	const graph = $derived.by(() => {
		const best = new Map<string, { slack: number; t: any; milestone: any }>();
		const milestoneRows: any[] = [];
		for (const m of roadmap.milestones) {
			for (const t of m.tasks) {
				if (t.itemType === 'milestone') continue;
				const slack = t.slackDays ?? 9999;
				const prev = best.get(t.id);
				if (!prev || slack < prev.slack) best.set(t.id, { slack, t, milestone: m });
			}
			milestoneRows.push(m);
		}
		const chainTasks = [...best.values()];
		const parkedTasks: any[] = (roadmap.parked ?? []).filter((p: any) => !best.has(p.id));
		const present = new Set<string>([...best.keys(), ...milestoneRows.map((m: any) => m.id)]);
		const edges: { source: string; target: string }[] = [];
		const seen = new Set<string>();
		const push = (s: string, tgt: string) => {
			const k = s + '→' + tgt;
			if (present.has(s) && present.has(tgt) && s !== tgt && !seen.has(k)) { seen.add(k); edges.push({ source: s, target: tgt }); }
		};
		for (const { t } of chainTasks) for (const p of t.blockedBy ?? []) push(p, t.id);
		for (const m of roadmap.milestones) {
			const mRow = m.tasks.find((t: any) => t.id === m.id);
			for (const p of mRow?.blockedBy ?? []) push(p, m.id);
		}
		return { chainTasks, parkedTasks, milestoneRows, edges };
	});

	// KB2-36 — chip census over everything on the map.
	const tagCounts = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const { t } of graph.chainTasks) for (const tag of t.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
		for (const t of graph.parkedTasks) for (const tag of t.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => b[1] - a[1]);
	});
	const tagDim = (t: any): boolean =>
		tagFilter.size > 0 && !(t.tags ?? []).some((x: string) => tagFilter.has(x));

	// ---- adjacency for focus mode
	const adj = $derived.by(() => {
		const up = new Map<string, string[]>(), down = new Map<string, string[]>();
		for (const e of graph.edges) {
			(up.get(e.target) ?? up.set(e.target, []).get(e.target)!).push(e.source);
			(down.get(e.source) ?? down.set(e.source, []).get(e.source)!).push(e.target);
		}
		return { up, down };
	});

	const focusSet = $derived.by(() => {
		if (!focusId) return null;
		const s = new Set<string>([focusId]);
		for (const dir of [adj.up, adj.down]) {
			const stack = [focusId];
			while (stack.length) {
				const cur = stack.pop()!;
				for (const n of dir.get(cur) ?? []) if (!s.has(n)) { s.add(n); stack.push(n); }
			}
		}
		return s;
	});

	// ---- node-data builders
	function taskData(t: any, parked: boolean, dimmedFn: (id: string) => boolean, critical: Map<string, boolean>) {
		return {
			id: t.id,
			title: t.title,
			trackingNumber: t.trackingNumber,
			status: t.status,
			done: t.done ?? false,
			lane: (t.tags ?? [])[0] ?? 'untagged',
			tags: t.tags ?? [],
			durationDays: t.durationDays,
			estimateSource: t.estimateSource,
			slackDays: t.slackDays ?? null,
			critical: !parked && (critical.get(t.id) ?? false),
			late: !parked && (t.late ?? false),
			parked,
			dimmed: dimmedFn(t.id),
			lines: titleLines(t),
			heightPx: heightOf(t),
			onPort,
			pendingPort: pendingPort && pendingPort.id === t.id ? pendingPort.side : null
		};
	}
	function milestoneData(m: any, dimmedFn: (id: string) => boolean) {
		return {
			id: m.id,
			title: m.title,
			shortTitle: m.title.replace(/^MILESTONE:\s*/i, ''),
			dueDate: m.dueDate,
			bufferDays: m.bufferDays,
			feasible: m.feasible,
			dimmed: dimmedFn(m.id),
			onPort,
			pendingPort: pendingPort && pendingPort.id === m.id ? pendingPort.side : null
		};
	}

	// Timeline position date: capacity-sequenced plan first, schedule fallback,
	// today for undated parked work.
	const todayIso = new Date(new Date().setHours(0, 0, 0, 0));
	const timelineDateOf = (t: any): string =>
		t.plannedStart ?? t.earlyStart ?? todayIso.toISOString().slice(0, 10);

	// ---- timeline scale
	const timeScale = $derived.by(() => {
		const dates: number[] = [];
		const push = (d: string | null | undefined) => {
			if (d) dates.push(new Date(d + 'T00:00:00').getTime());
		};
		for (const { t } of graph.chainTasks) { push(timelineDateOf(t)); push(t.plannedFinish); }
		for (const t of graph.parkedTasks) { push(timelineDateOf(t)); push(t.plannedFinish); }
		for (const m of graph.milestoneRows) push(m.dueDate);
		const now = todayIso.getTime();
		const min = (dates.length ? Math.min(...dates, now) : now) - 6 * DAY_MS;
		const max = (dates.length ? Math.max(...dates, now) : now) + 12 * DAY_MS;
		const xOf = (ms: number) => ((ms - min) / DAY_MS) * PX_PER_DAY;
		return { min, max, xOf, width: xOf(max) };
	});

	// ---- timeline layout (pure derived) — KB2-36: y = CHAIN BANDS (connected
	// components over the drawn blocking edges), not tag lanes. The vertical
	// order finally means something: hot chains first. Unwired singles pack
	// into one compact backlog block at the bottom.
	const timelineLayout = $derived.by(() => {
		const chain = graph.chainTasks.filter(({ t }) => !(hideDone && t.done));
		const { xOf } = timeScale;
		const Y0 = 0, BAND_PAD = 16, ROW_GAP = 12;

		// KB2-39: bands = CHAINS — each task's PRIMARY milestone DAG from
		// deriveChains() (same links, same doctrine: derived per load). Ordered
		// by the chain service (dated milestones by due date first). Anything
		// the service didn't place (e.g. blocks-only edges the scheduler sees
		// differently) falls back to one trailing "wired" band.
		const chainMeta = new Map<string, any>((chains?.chains ?? []).map((c: any) => [c.id, c]));
		const byTask: Record<string, any> = chains?.byTask ?? {};
		const groups = new Map<string, any[]>();
		for (const { t } of chain) {
			const key = byTask[t.id]?.chainId ?? '__wired__';
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(t);
		}
		const chainOrder: string[] = [...(chains?.chains ?? []).map((c: any) => c.id), '__wired__'];
		const orderIdx = (k: string) => { const i = chainOrder.indexOf(k); return i === -1 ? 1e9 : i; };
		const bands = [...groups.entries()]
			.map(([key, tasks]) => ({
				key,
				meta: chainMeta.get(key) ?? null,
				tasks: tasks.sort((a, b) => timelineDateOf(a).localeCompare(timelineDateOf(b))),
				earliest: tasks.reduce((min, t) => (timelineDateOf(t) < min ? timelineDateOf(t) : min), '9999')
			}))
			.sort((a, b) => orderIdx(a.key) - orderIdx(b.key) || a.earliest.localeCompare(b.earliest));

		let y = Y0;
		const positions = new Map<string, { x: number; y: number }>();
		const bandRects: { y: number; height: number; key: string; meta: any; x: number }[] = [];
		// Rows are variable-height now (cards grow with their title): assign
		// tasks to rows greedily by x first, then stack rows by each row's
		// tallest card. Returns the vertical space consumed.
		const packInto = (tasks: any[], startY: number): number => {
			const rowEnds: number[] = [];
			const rowMaxH: number[] = [];
			const placed: { id: string; x: number; row: number }[] = [];
			for (const t of tasks) {
				// A milestone rides its band like a card: centred on its due-date
				// line, milestone-sized, so it sits at the END of its own lane.
				const mile = t.__mile === true;
				const x = mile
					? xOf(new Date(t.dueDate + 'T00:00:00').getTime()) - MILE_W / 2
					: xOf(new Date(timelineDateOf(t) + 'T00:00:00').getTime());
				const w = mile ? MILE_W : TASK_W;
				const h = mile ? MILE_H : heightOf(t);
				let row = rowEnds.findIndex((e) => e <= x);
				if (row === -1) { row = rowEnds.length; rowEnds.push(0); rowMaxH.push(0); }
				rowEnds[row] = x + w + 24;
				rowMaxH[row] = Math.max(rowMaxH[row], h);
				placed.push({ id: t.id, x, row });
			}
			const rowY: number[] = [];
			let yy = startY;
			for (const h of rowMaxH) { rowY.push(yy); yy += h + ROW_GAP; }
			for (const p of placed) positions.set(p.id, { x: p.x, y: rowY[p.row] });
			return Math.max(TASK_H + ROW_GAP, yy - startY);
		};
		// KB2-39: a label rail sits above each band's cards.
		const LABEL_H = 26;
		const dateOfItem = (t: any): string => (t.__mile ? t.dueDate : timelineDateOf(t));
		for (const band of bands) {
			// The chain's milestone ends its own lane (Jacob 2026-09-02) instead of
			// clustering in a top strip. Sorted by date with the cards so the
			// greedy row packing still works when a chain runs past its date.
			const m = band.meta?.kind === 'milestone' ? graph.milestoneRows.find((x: any) => x.id === band.key) : null;
			const items = m ? [...band.tasks, { __mile: true, id: m.id, dueDate: m.dueDate }] : band.tasks;
			items.sort((a: any, b: any) => dateOfItem(a).localeCompare(dateOfItem(b)));
			const used = packInto(items, y + BAND_PAD + LABEL_H);
			const height = BAND_PAD * 2 + LABEL_H + used;
			// Rail x = the band's leftmost card, so the label is never clipped by
			// the opening viewport (which starts just right of canvas x=0).
			const x = band.tasks.reduce((min, t) => Math.min(min, positions.get(t.id)?.x ?? min), Infinity);
			bandRects.push({ y, height, key: band.key, meta: band.meta, x: Number.isFinite(x) ? x : 12 });
			y += height;
		}
		// Unwired backlog block (KB2-34 ghosts) — separated, packed by planned date.
		const unwiredY = y + 46;
		const parkedSorted = [...graph.parkedTasks].sort((a: any, b: any) =>
			timelineDateOf(a).localeCompare(timelineDateOf(b))
		);
		const unwiredUsed = parkedSorted.length ? packInto(parkedSorted, unwiredY + BAND_PAD) : 0;
		const totalH = parkedSorted.length ? unwiredY + BAND_PAD * 2 + unwiredUsed : y;

		// Milestones with no band on this map (no open chain tasks, or all hidden)
		// fall back to the top strip so they are never lost.
		graph.milestoneRows.filter((m: any) => !positions.has(m.id)).forEach((m: any, i: number) => {
			positions.set(m.id, {
				x: xOf(new Date(m.dueDate + 'T00:00:00').getTime()) - MILE_W / 2,
				y: Y0 - MILE_H - 10 - (i % 2) * 30
			});
		});
		return { positions, bands: bandRects, unwiredY: parkedSorted.length ? unwiredY : null, totalH };
	});

	// ---- flow layout: dagre over the wired graph, parked grid below (KB2-34)
	const flowLayout = $derived.by(() => {
		const chain = graph.chainTasks.filter(({ t }) => !(hideDone && t.done));
		const g = new dagre.graphlib.Graph();
		g.setGraph({ rankdir: 'LR', ranksep: 110, nodesep: 26, marginx: 40, marginy: 40 });
		g.setDefaultEdgeLabel(() => ({}));
		for (const { t } of chain) g.setNode(t.id, { width: TASK_W, height: heightOf(t) });
		for (const m of graph.milestoneRows) g.setNode(m.id, { width: MILE_W, height: MILE_H });
		for (const e of graph.edges) g.setEdge(e.source, e.target);
		dagre.layout(g);
		let maxY = 0, maxX = 0;
		const positions = new Map<string, { x: number; y: number }>();
		const place = (id: string, w: number, h: number) => {
			const pin = pinMap.get(id);
			const n = g.node(id);
			const pos = pin ?? { x: (n?.x ?? 0) - w / 2, y: (n?.y ?? 0) - h / 2 };
			positions.set(id, pos);
			maxY = Math.max(maxY, pos.y + h);
			maxX = Math.max(maxX, pos.x + w);
		};
		for (const { t } of chain) place(t.id, TASK_W, heightOf(t));
		for (const m of graph.milestoneRows) place(m.id, MILE_W, MILE_H);
		// Parked grid below the graph — dagre would dump the disconnected set
		// into one giant first column (the original collapse, reborn). Grid rows
		// step by their tallest card (heights vary with wrapped titles).
		const PER_ROW = Math.max(3, Math.floor(Math.max(maxX, 1200) / (TASK_W + 30)));
		const sorted = [...graph.parkedTasks].sort((a: any, b: any) => a.rank - b.rank);
		let gy = maxY + 110, gridRowH = 0;
		sorted.forEach((t: any, i: number) => {
			const col = i % PER_ROW;
			if (col === 0 && i > 0) { gy += gridRowH + 26; gridRowH = 0; }
			gridRowH = Math.max(gridRowH, heightOf(t));
			const pin = pinMap.get(t.id);
			positions.set(t.id, pin ?? { x: 40 + col * (TASK_W + 30), y: gy });
		});
		return { positions, parkedBandY: maxY + 70 };
	});

	// ---- nodes/edges for SvelteFlow
	const flowData = $derived.by(() => {
		const chain = graph.chainTasks.filter(({ t }) => !(hideDone && t.done));
		const mIds = new Set(graph.milestoneRows.map((m: any) => m.id));
		const visible = new Set<string>([...chain.map(({ t }) => t.id), ...mIds]);
		const edges = graph.edges.filter((e) => visible.has(e.source) && visible.has(e.target));
		const taskById = new Map<string, any>([
			...graph.chainTasks.map(({ t }) => [t.id, t] as [string, any]),
			...graph.parkedTasks.map((t: any) => [t.id, t] as [string, any])
		]);
		// KB2-36: focus dim OR tag-filter dim (milestones never tag-dim).
		const dimmed = (id: string) => {
			const focusDim = focusSet ? !focusSet.has(id) : false;
			const t = taskById.get(id);
			return focusDim || (t ? tagDim(t) : false);
		};
		const critical = new Map(graph.chainTasks.map(({ t }) => [t.id, t.onCriticalChain && !t.done]));
		const positions = mode === 'timeline' ? timelineLayout.positions : flowLayout.positions;
		const draggable = mode === 'flow';

		const nodes: Node[] = [
			...chain.map(({ t }) => ({
				id: t.id,
				type: 'task',
				position: positions.get(t.id) ?? { x: 0, y: 0 },
				draggable,
				data: taskData(t, false, dimmed, critical)
			})),
			...graph.parkedTasks.map((t: any) => ({
				id: t.id,
				type: 'task',
				position: positions.get(t.id) ?? { x: 0, y: 0 },
				draggable,
				data: taskData(t, true, dimmed, critical)
			})),
			...graph.milestoneRows.map((m: any) => ({
				id: m.id,
				type: 'milestone',
				position: positions.get(m.id) ?? { x: 0, y: 0 },
				draggable,
				data: milestoneData(m, dimmed)
			}))
		];

		// Edge quiet (KB2-35): non-critical dimmed by default; focus overrides.
		const flowEdges: Edge[] = edges.map((e) => {
			const crit = (critical.get(e.source) ?? false) && ((critical.get(e.target) ?? false) || mIds.has(e.target));
			const inFocus = focusSet ? focusSet.has(e.source) && focusSet.has(e.target) : null;
			const tagDimEdge = dimmed(e.source) || dimmed(e.target);
			const opacity = tagDimEdge ? 0.06 : inFocus === null ? (crit ? 0.9 : 0.3) : inFocus ? 1 : 0.06;
			return {
				id: `${e.source}→${e.target}`,
				source: e.source,
				target: e.target,
				type: 'smoothstep',
				animated: crit && inFocus !== false,
				style: `stroke: ${crit ? '#f87171' : 'rgba(0,212,255,0.5)'}; stroke-width: ${crit ? 2.4 : 1.4}; opacity: ${opacity};`
			};
		});

		return { nodes, edges: flowEdges };
	});

	// Canvas-space backdrop: gridlines/bands only — ALL text lives in the
	// screen-space floating axis (KB2-35).
	const backdrop = $derived.by(() => {
		if (mode !== 'timeline') return null;
		const { min, max, xOf } = timeScale;
		const weeks: { x: number; ms: number }[] = [];
		const months: { x: number; ms: number }[] = [];
		const d = new Date(min);
		d.setDate(d.getDate() + ((8 - d.getDay()) % 7));
		while (d.getTime() <= max) {
			weeks.push({ x: xOf(d.getTime()), ms: d.getTime() });
			d.setDate(d.getDate() + 7);
		}
		const m0 = new Date(min); m0.setDate(1); m0.setMonth(m0.getMonth() + 1);
		while (m0.getTime() <= max) {
			months.push({ x: xOf(m0.getTime()), ms: m0.getTime() });
			m0.setMonth(m0.getMonth() + 1);
		}
		return {
			weeks,
			months,
			todayX: xOf(todayIso.getTime()),
			milestones: graph.milestoneRows.map((m: any) => ({
				x: xOf(new Date(m.dueDate + 'T00:00:00').getTime()),
				feasible: m.feasible
			}))
		};
	});

	const BACKDROP_TOP = -190;

	// Screen-space x for the floating axis.
	const screenX = (canvasX: number) => vp.x + canvasX * vp.zoom;
	const fmtTick = (ms: number) =>
		new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	const fmtMonth = (ms: number) =>
		new Date(ms).toLocaleDateString('en-US', { month: 'long' });

	let nodes = $state.raw<Node[]>([]);
	let edges = $state.raw<Edge[]>([]);
	$effect(() => {
		nodes = flowData.nodes;
		edges = flowData.edges;
	});

	async function onDragStop(event: any) {
		if (mode !== 'flow') return;
		const dragged: Node[] = event.nodes ?? (event.targetNode ? [event.targetNode] : []);
		for (const n of dragged) {
			pinMap.set(n.id, { x: n.position.x, y: n.position.y });
			const body = new FormData();
			body.set('taskId', n.id);
			body.set('x', String(n.position.x));
			body.set('y', String(n.position.y));
			try {
				deserialize(await (await fetch('?/pinNode', { method: 'POST', body })).text());
			} catch { /* presentation-only */ }
		}
		pinMap = new Map(pinMap);
	}

	async function relayout() {
		const res = await fetch('?/relayout', { method: 'POST', body: new FormData() });
		deserialize(await res.text());
		pinMap = new Map();
	}

	function onEsc() {
		if (pendingPort) pendingPort = null;
		else if (focusId) focusId = null;
		else if (fullscreen) fullscreen = false;
	}
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onEsc(); }} />

<section
	class={fullscreen
		? 'fixed inset-0 z-50 flex flex-col bg-[#060b14]'
		: 'flex flex-col border-y border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]'}
>
	<div class="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
		<div class="flex items-center gap-3">
			<div class="text-sm font-bold tron-text-primary">Dependency map</div>
			<div class="flex overflow-hidden rounded border border-[var(--color-tron-border)] text-xs">
				<button
					type="button"
					class="px-2.5 py-1 {mode === 'timeline' ? 'bg-[var(--color-tron-cyan)] font-bold text-[var(--color-tron-bg-primary)]' : 'tron-text-muted hover:text-[var(--color-tron-cyan)]'}"
					onclick={() => (mode = 'timeline')}
					title="x-axis = time: cards at their planned turn through the team pipe"
				>Timeline</button>
				<button
					type="button"
					class="px-2.5 py-1 {mode === 'flow' ? 'bg-[var(--color-tron-cyan)] font-bold text-[var(--color-tron-bg-primary)]' : 'tron-text-muted hover:text-[var(--color-tron-cyan)]'}"
					onclick={() => (mode = 'flow')}
					title="dependency structure; drag to arrange (pins persist)"
				>Flow</button>
			</div>
			{#if pendingPort}
				<span class="rounded border border-[var(--color-tron-cyan)]/60 bg-[rgba(0,212,255,0.08)] px-2 py-0.5 text-[11px] font-bold text-[var(--color-tron-cyan)]">
					Connecting {pendingPort.label} — click the {pendingPort.side === 'right' ? 'LEFT ○ of the task that comes AFTER it' : 'RIGHT ○ of the task that comes BEFORE it'} · Esc cancels
				</span>
			{:else if connectBusy}
				<span class="text-[11px] tron-text-muted">wiring…</span>
			{/if}
			{#if connectError}
				<span class="text-[11px] font-bold text-red-300">{connectError}</span>
			{/if}
			{#if (roadmap.parked?.length ?? 0) > 0}
				<span class="rounded-full border border-slate-500/40 bg-slate-500/10 px-2 py-0.5 text-[11px] font-bold text-slate-300"
					title="Open tasks wired into no milestone chain — ghosted on the map; open one and add dependencies to wire it in">
					{roadmap.parked.length} unwired
				</span>
			{/if}
			{#if onnewmilestone}
				<button
					type="button"
					onclick={() => onnewmilestone?.()}
					class="rounded border border-dashed border-[var(--color-tron-border)] px-2 py-0.5 text-[11px] tron-text-muted transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
					title="Add a dated milestone and wire the chain it waits on"
				>◆ + Milestone</button>
			{/if}
		</div>
		<div class="flex items-center gap-3 text-xs">
			<label class="flex cursor-pointer items-center gap-1.5 tron-text-muted">
				<input type="checkbox" bind:checked={hideDone} /> hide done
			</label>
			{#if mode === 'flow'}
				<button type="button" class="tron-button !px-2 !py-1" onclick={relayout} title="Clear pinned positions, re-run auto-layout">Re-layout</button>
			{/if}
			<button
				type="button"
				class="tron-button !px-2 !py-1"
				onclick={() => (fullscreen = !fullscreen)}
				title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
			>{fullscreen ? '✕ Exit' : '⛶ Fullscreen'}</button>
		</div>
	</div>
	{#if tagCounts.length}
		<div class="flex flex-wrap items-center gap-1.5 border-t border-[var(--color-tron-border)] px-4 py-1.5">
			{#each tagCounts as [tag, n] (tag)}
				{@const active = tagFilter.has(tag)}
				<button
					type="button"
					class="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-all"
					style="border-color: {active ? tagColor(tag) : 'var(--color-tron-border)'}; background: {active ? tagColor(tag) + '26' : 'transparent'}; color: {active ? tagColor(tag) : 'var(--color-tron-text-secondary)'};"
					onclick={() => toggleTag(tag)}
					title={active ? 'Click to remove from filter' : 'Click to filter — everything else dims; multi-select unions'}
				>
					<span class="h-2 w-2 rounded-full" style="background: {tagColor(tag)};"></span>
					{tag}
					<span class="opacity-60">{n}</span>
				</button>
			{/each}
			{#if tagFilter.size}
				<button type="button" class="ml-1 text-[11px] font-bold text-[var(--color-tron-cyan)] hover:underline" onclick={clearTags}>clear</button>
			{/if}
		</div>
	{/if}
	<!-- flex-1 only in fullscreen: outside it the section has auto height, so
	     flex-basis 0% would override the inline height and collapse the canvas
	     to 0px (KB2-35 bug found live 2026-08-21: 141 nodes rendering into a
	     zero-height clipped box). -->
	<div class={fullscreen ? 'relative min-h-0 flex-1' : 'relative'} style={fullscreen ? '' : 'height: 78vh; min-height: 520px;'}>
		<SvelteFlow
			bind:nodes
			bind:edges
			{nodeTypes}
			minZoom={0.15}
			maxZoom={2.2}
			onnodeclick={({ node }) => (focusId = focusId === node.id ? null : node.id)}
			onpaneclick={() => { focusId = null; pendingPort = null; }}
			onnodedragstop={onDragStop}
			colorMode="dark"
		>
			<CanvasRefit signal={mode + (fullscreen ? ':fs' : '')} />
			<ViewportReporter onviewport={(v) => (vp = v)} />
			<Background bgColor="#060b14" patternColor="#152232" gap={26} />
			{#if mode === 'timeline' && backdrop}
				<ViewportPortal target="back">
					{#each backdrop.weeks as w (w.x)}
						<div style="position:absolute; left:{w.x}px; top:{BACKDROP_TOP}px; width:1px; height:{timelineLayout.totalH - BACKDROP_TOP + 60}px; background: rgba(27,42,58,0.9);"></div>
					{/each}
					<div style="position:absolute; left:{backdrop.todayX}px; top:{BACKDROP_TOP}px; width:2px; height:{timelineLayout.totalH - BACKDROP_TOP + 60}px; background: var(--color-tron-cyan, #00d4ff); box-shadow: 0 0 10px rgba(0,212,255,0.6);"></div>
					{#each backdrop.milestones as mm (mm.x)}
						<div style="position:absolute; left:{mm.x}px; top:{BACKDROP_TOP}px; width:1.5px; height:{timelineLayout.totalH - BACKDROP_TOP + 60}px; background: {mm.feasible ? 'rgba(52,211,153,0.5)' : 'rgba(248,113,113,0.55)'};"></div>
					{/each}
					{#each timelineLayout.bands as B, i (B.y)}
						{#if i % 2 === 1}
							<div style="position:absolute; left:-260px; top:{B.y}px; width:{timeScale.width + 320}px; height:{B.height}px; background: rgba(255,255,255,0.018);"></div>
						{/if}
						<!-- KB2-39: chain label rail — name · due · buffer · progress · Tier 1 / plan links -->
						{@const ms = B.meta ? roadmap.milestones.find((m: any) => m.id === B.key) : null}
						<div style="position:absolute; left:{B.x}px; top:{B.y + 6}px; display:flex; gap:12px; align-items:baseline; font-size:13px; white-space:nowrap; color:#94a3b8;">
							<span style="font-weight:800; letter-spacing:0.06em; color:{B.meta ? (B.meta.kind === 'milestone' ? '#e2e8f0' : '#94a3b8') : '#94a3b8'};">
								{B.meta ? B.meta.name.toUpperCase() : 'WIRED'}
							</span>
							{#if B.meta?.dueDate}<span>due {B.meta.dueDate}</span>{/if}
							{#if ms}
								<span style="color:{ms.feasible ? '#34d399' : '#f87171'};">{ms.bufferDays >= 0 ? '+' : ''}{ms.bufferDays} wd buffer</span>
							{/if}
							{#if B.meta}<span>{B.meta.done}/{B.meta.total} done · {B.meta.nextUp.length} next up</span>{/if}
							{#if B.meta}
								<a href="/kanban/inventory?chain={B.key}&view=chain" style="color: var(--color-tron-cyan, #00d4ff); pointer-events:auto;">Tier 1 ›</a>
							{/if}
							{#if B.meta?.planId}
								<a href="/kanban/plans/{B.meta.planId}" style="color: var(--color-tron-cyan, #00d4ff); pointer-events:auto;" title={B.meta.planTitle}>plan ›</a>
							{/if}
						</div>
					{/each}
					{#if timelineLayout.unwiredY !== null}
						<div style="position:absolute; left:-260px; top:{timelineLayout.unwiredY - 12}px; width:{timeScale.width + 320}px; height:0; border-top: 1px dashed rgba(148,163,184,0.35);"></div>
						<div style="position:absolute; left:12px; top:{timelineLayout.unwiredY - 4}px; font-size:14px; font-weight:800; letter-spacing:0.1em; color:#94a3b8;">UNWIRED BACKLOG — open a task and add dependencies to wire it in</div>
					{/if}
				</ViewportPortal>
			{/if}
			<Controls position="bottom-left" />
			<MiniMap
				position="bottom-right"
				pannable
				zoomable
				bgColor="#0b1220"
				nodeColor={(n: Node) => ((n.data as any)?.parked ? 'rgba(148,163,184,0.35)' : (n.data as any)?.critical ? '#f87171' : 'rgba(0,212,255,0.45)')}
				maskColor="rgba(6,11,20,0.75)"
			/>
		</SvelteFlow>

		{#if mode === 'timeline' && backdrop}
			<!-- KB2-35 floating axis: screen-space, tracks horizontal pan/zoom,
			     ignores vertical — chronology always visible. -->
			<div class="pointer-events-none absolute inset-x-0 top-0 overflow-hidden" style="height: {AXIS_H}px; background: linear-gradient(to bottom, rgba(6,11,20,0.96) 55%, rgba(6,11,20,0));">
				{#each backdrop.months as mth (mth.ms)}
					<div style="position:absolute; left:{screenX(mth.x) + 6}px; top:2px; font-size:12.5px; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:#cbd5e1;">{fmtMonth(mth.ms)}</div>
				{/each}
				{#each backdrop.weeks as w (w.ms)}
					{#if vp.zoom >= 0.35}
						<div style="position:absolute; left:{screenX(w.x) + 3}px; top:20px; font-size:10px; font-family: ui-monospace, monospace; color:#7b8ba3;">{fmtTick(w.ms)}</div>
					{/if}
					<div style="position:absolute; left:{screenX(w.x)}px; top:32px; width:1px; height:8px; background:#2a3b52;"></div>
				{/each}
				<div style="position:absolute; left:{screenX(backdrop.todayX) - 18}px; top:3px; font-size:10px; font-weight:800; color:#00d4ff; background:rgba(0,212,255,0.12); border:1px solid rgba(0,212,255,0.5); border-radius:4px; padding:0 5px;">today</div>
			</div>
		{/if}
	</div>
</section>
