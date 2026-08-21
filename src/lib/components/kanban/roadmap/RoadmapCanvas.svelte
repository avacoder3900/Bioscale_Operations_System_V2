<script lang="ts">
	/**
	 * KB2-30 — the infinite-zoom dependency canvas (replaced the KB2-29
	 * swimlane timeline). Two layout modes, same node/edge aesthetic:
	 *
	 *  · TIMELINE (default) — the x-axis IS time: cards sit at their scheduled
	 *    early-start, milestones at their due date, week gridlines + month
	 *    labels + today line behind the graph (ViewportPortal target="back").
	 *    "A gantt sort of, but not really" — nodes and dependency edges, on a
	 *    time-true axis. Positions are derived → dragging is disabled here.
	 *  · FLOW — pure dagre left-to-right structure, time-free. Dragging pins
	 *    positions (?/pinNode — shared layout, Miro model).
	 *
	 * Focus mode (both): click a node → its full upstream/downstream chain
	 * stays lit, everything else dims; click the pane or Esc to clear.
	 */
	import { SvelteFlow, Background, Controls, MiniMap, ViewportPortal } from '@xyflow/svelte';
	import type { Node, Edge } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import dagre from '@dagrejs/dagre';
	import TaskNode from './TaskNode.svelte';
	import MilestoneNode from './MilestoneNode.svelte';
	import CanvasRefit from './CanvasRefit.svelte';
	import { tagColor } from '$lib/shared/tag-color';
	import { deserialize } from '$app/forms';

	let {
		roadmap,
		pinned
	}: {
		roadmap: any;
		pinned: { _id: string; x: number; y: number }[];
	} = $props();

	const nodeTypes = { task: TaskNode, milestone: MilestoneNode };

	const TASK_W = 230, TASK_H = 64, MILE_W = 210, MILE_H = 96;
	const DAY_MS = 24 * 60 * 60 * 1000;
	const PX_PER_DAY = 26; // calendar days → px on the timeline axis

	let mode = $state<'timeline' | 'flow'>('timeline');
	let hideDone = $state(false);
	let focusId = $state<string | null>(null);
	// Local pin map (FLOW mode only) — updated on drag so rebuilds keep positions.
	// svelte-ignore state_referenced_locally — deliberate: seed once from the
	// load data; afterwards drags/relayout own it.
	let pinMap = $state(new Map(pinned.map((p) => [p._id, { x: p.x, y: p.y }])));

	// ---- graph model: dedupe tasks across milestone subgraphs (min slack wins)
	const graph = $derived.by(() => {
		type Row = { t: any; milestone: any };
		const best = new Map<string, { slack: number; row: Row }>();
		const milestoneRows: any[] = [];
		for (const m of roadmap.milestones) {
			for (const t of m.tasks) {
				if (t.itemType === 'milestone') continue;
				const slack = t.slackDays ?? 9999;
				const prev = best.get(t.id);
				if (!prev || slack < prev.slack) best.set(t.id, { slack, row: { t, milestone: m } });
			}
			milestoneRows.push(m);
		}
		const tasks = [...best.values()].map((x) => x.row);
		const present = new Set<string>([...best.keys(), ...milestoneRows.map((m: any) => m.id)]);
		const edges: { source: string; target: string }[] = [];
		const seen = new Set<string>();
		const push = (s: string, tgt: string) => {
			const k = s + '→' + tgt;
			if (present.has(s) && present.has(tgt) && s !== tgt && !seen.has(k)) { seen.add(k); edges.push({ source: s, target: tgt }); }
		};
		for (const { t } of tasks) for (const p of t.blockedBy ?? []) push(p, t.id);
		for (const m of roadmap.milestones) {
			const mRow = m.tasks.find((t: any) => t.id === m.id);
			for (const p of mRow?.blockedBy ?? []) push(p, m.id);
		}
		return { tasks, milestoneRows, edges };
	});

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

	// ---- shared node-data builders
	function taskData(t: any, dimmedFn: (id: string) => boolean, critical: Map<string, boolean>) {
		return {
			id: t.id,
			title: t.title,
			trackingNumber: t.trackingNumber,
			status: t.status,
			done: t.done,
			lane: (t.tags ?? [])[0] ?? 'untagged',
			durationDays: t.durationDays,
			estimateSource: t.estimateSource,
			slackDays: t.slackDays,
			critical: critical.get(t.id) ?? false,
			late: t.late,
			dimmed: dimmedFn(t.id)
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
			dimmed: dimmedFn(m.id)
		};
	}

	// KB2-30 addendum: Timeline positions by the capacity-sequenced PLAN
	// (plannedStart — when the task gets its turn through the team pipe), not
	// by earlyStart. earlyStart made every unblocked card pile at "today"
	// (everything COULD start now) — the collapse Jacob reported 2026-08-21.
	const timelineDateOf = (t: any): string | null => t.plannedStart ?? t.earlyStart ?? null;

	// ---- timeline scale (shared by node layout + backdrop decorations)
	const timeScale = $derived.by(() => {
		const dates: number[] = [];
		for (const { t } of graph.tasks) {
			const d = timelineDateOf(t);
			if (d) dates.push(new Date(d + 'T00:00:00').getTime());
			if (t.plannedFinish) dates.push(new Date(t.plannedFinish + 'T00:00:00').getTime());
		}
		for (const m of graph.milestoneRows) dates.push(new Date(m.dueDate + 'T00:00:00').getTime());
		const now = Date.now();
		const min = (dates.length ? Math.min(...dates, now) : now) - 6 * DAY_MS;
		const max = (dates.length ? Math.max(...dates, now) : now) + 12 * DAY_MS;
		const xOf = (ms: number) => ((ms - min) / DAY_MS) * PX_PER_DAY;
		return { min, max, xOf, width: xOf(max) };
	});

	// ---- timeline layout (pure derived — flowData and the backdrop both read it)
	const timelineLayout = $derived.by(() => {
		const tasks = graph.tasks.filter(({ t }) => !(hideDone && t.done));
		const { xOf } = timeScale;
		const laneOf = (t: any) => (t.tags ?? [])[0] ?? 'untagged';
		const laneCounts = new Map<string, number>();
		for (const { t } of tasks) laneCounts.set(laneOf(t), (laneCounts.get(laneOf(t)) ?? 0) + 1);
		const laneOrder = [...laneCounts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);

		const Y0 = 0, LANE_PAD = 14, ROW_H = TASK_H + 12;
		let y = Y0;
		const lanes: { lane: string; y: number; rows: number }[] = [];
		const positions = new Map<string, { x: number; y: number }>();
		for (const lane of laneOrder) {
			const inLane = tasks
				.filter(({ t }) => laneOf(t) === lane)
				.sort((a, b) => String(timelineDateOf(a.t) ?? '') .localeCompare(String(timelineDateOf(b.t) ?? '')));
			const rowEnds: number[] = [];
			for (const { t } of inLane) {
				const x = xOf(new Date((timelineDateOf(t) ?? '1970-01-01') + 'T00:00:00').getTime());
				let row = rowEnds.findIndex((e) => e <= x);
				if (row === -1) { row = rowEnds.length; rowEnds.push(0); }
				rowEnds[row] = x + TASK_W + 24;
				positions.set(t.id, { x, y: y + LANE_PAD + row * ROW_H });
			}
			const rows = Math.max(1, rowEnds.length);
			lanes.push({ lane, y, rows });
			y += LANE_PAD * 2 + rows * ROW_H;
		}
		// Milestones float above the lanes at their due-date x.
		graph.milestoneRows.forEach((m: any, i: number) => {
			positions.set(m.id, {
				x: xOf(new Date(m.dueDate + 'T00:00:00').getTime()) - MILE_W / 2,
				y: Y0 - MILE_H - 18 - (i % 2) * (MILE_H + 8)
			});
		});
		return { positions, lanes, totalH: y };
	});

	// ---- layout + nodes/edges for SvelteFlow
	const flowData = $derived.by(() => {
		const tasks = graph.tasks.filter(({ t }) => !(hideDone && t.done));
		const mIds = new Set(graph.milestoneRows.map((m: any) => m.id));
		const visible = new Set<string>([...tasks.map(({ t }) => t.id), ...mIds]);
		const edges = graph.edges.filter((e) => visible.has(e.source) && visible.has(e.target));
		const dimmed = (id: string) => (focusSet ? !focusSet.has(id) : false);
		const critical = new Map(graph.tasks.map(({ t }) => [t.id, t.onCriticalChain && !t.done]));

		let nodes: Node[];

		if (mode === 'timeline') {
			// x = scheduled early start (fact for done: completion). y = tag lanes
			// with greedy sub-row packing. Positions are derived → no dragging.
			const { positions } = timelineLayout;
			nodes = [
				...tasks.map(({ t }) => ({
					id: t.id,
					type: 'task',
					position: positions.get(t.id) ?? { x: 0, y: 0 },
					draggable: false,
					data: taskData(t, dimmed, critical)
				})),
				...graph.milestoneRows.map((m: any) => ({
					id: m.id,
					type: 'milestone',
					position: positions.get(m.id) ?? { x: 0, y: 0 },
					draggable: false,
					data: milestoneData(m, dimmed)
				}))
			];
		} else {
			// FLOW: dagre structure; pinned positions win.
			const g = new dagre.graphlib.Graph();
			g.setGraph({ rankdir: 'LR', ranksep: 110, nodesep: 26, marginx: 40, marginy: 40 });
			g.setDefaultEdgeLabel(() => ({}));
			for (const { t } of tasks) g.setNode(t.id, { width: TASK_W, height: TASK_H });
			for (const m of graph.milestoneRows) g.setNode(m.id, { width: MILE_W, height: MILE_H });
			for (const e of edges) g.setEdge(e.source, e.target);
			dagre.layout(g);
			const pos = (id: string, w: number, h: number) => {
				const pin = pinMap.get(id);
				if (pin) return { x: pin.x, y: pin.y };
				const n = g.node(id);
				return { x: (n?.x ?? 0) - w / 2, y: (n?.y ?? 0) - h / 2 };
			};
			nodes = [
				...tasks.map(({ t }) => ({
					id: t.id,
					type: 'task',
					position: pos(t.id, TASK_W, TASK_H),
					draggable: true,
					data: taskData(t, dimmed, critical)
				})),
				...graph.milestoneRows.map((m: any) => ({
					id: m.id,
					type: 'milestone',
					position: pos(m.id, MILE_W, MILE_H),
					draggable: true,
					data: milestoneData(m, dimmed)
				}))
			];
		}

		const flowEdges: Edge[] = edges.map((e) => {
			const crit = (critical.get(e.source) ?? false) && ((critical.get(e.target) ?? false) || mIds.has(e.target));
			const dim = focusSet ? !(focusSet.has(e.source) && focusSet.has(e.target)) : false;
			return {
				id: `${e.source}→${e.target}`,
				source: e.source,
				target: e.target,
				type: mode === 'timeline' ? 'default' : 'smoothstep',
				animated: crit && !dim,
				style: `stroke: ${crit ? '#f87171' : 'rgba(0,212,255,0.35)'}; stroke-width: ${crit ? 2.2 : 1.4}; opacity: ${dim ? 0.08 : 1};`
			};
		});

		return { nodes, edges: flowEdges };
	});

	// Week gridlines (Mondays) + month labels + today + milestone verticals.
	const backdrop = $derived.by(() => {
		if (mode !== 'timeline') return null;
		const { min, max, xOf } = timeScale;
		const weeks: { x: number; label: string }[] = [];
		const months: { x: number; label: string }[] = [];
		const d = new Date(min);
		d.setDate(d.getDate() + ((8 - d.getDay()) % 7)); // next Monday
		while (d.getTime() <= max) {
			weeks.push({ x: xOf(d.getTime()), label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) });
			d.setDate(d.getDate() + 7);
		}
		const m0 = new Date(min); m0.setDate(1); m0.setMonth(m0.getMonth() + 1);
		while (m0.getTime() <= max) {
			months.push({ x: xOf(m0.getTime()), label: m0.toLocaleDateString('en-US', { month: 'long' }) });
			m0.setMonth(m0.getMonth() + 1);
		}
		return {
			weeks,
			months,
			todayX: xOf(new Date(new Date().setHours(0, 0, 0, 0)).getTime()),
			milestones: graph.milestoneRows.map((m: any) => ({
				x: xOf(new Date(m.dueDate + 'T00:00:00').getTime()),
				feasible: m.feasible
			}))
		};
	});

	// SvelteFlow mutates its arrays internally on drag — feed it fresh copies
	// whenever the derived graph changes.
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
			} catch { /* presentation-only; a lost pin re-layouts next visit */ }
		}
		pinMap = new Map(pinMap);
	}

	async function relayout() {
		const res = await fetch('?/relayout', { method: 'POST', body: new FormData() });
		deserialize(await res.text());
		pinMap = new Map();
	}

	const BACKDROP_TOP = -230; // above the milestone strip
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') focusId = null; }} />

<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
	<div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-tron-border)] px-4 py-2">
		<div class="flex items-center gap-3">
			<div class="text-sm font-bold tron-text-primary">Dependency map</div>
			<div class="flex overflow-hidden rounded border border-[var(--color-tron-border)] text-xs">
				<button
					type="button"
					class="px-2.5 py-1 {mode === 'timeline' ? 'bg-[var(--color-tron-cyan)] font-bold text-[var(--color-tron-bg-primary)]' : 'tron-text-muted hover:text-[var(--color-tron-cyan)]'}"
					onclick={() => (mode = 'timeline')}
					title="x-axis = time: cards at their scheduled start, milestones at their due date"
				>Timeline</button>
				<button
					type="button"
					class="px-2.5 py-1 {mode === 'flow' ? 'bg-[var(--color-tron-cyan)] font-bold text-[var(--color-tron-bg-primary)]' : 'tron-text-muted hover:text-[var(--color-tron-cyan)]'}"
					onclick={() => (mode = 'flow')}
					title="pure dependency structure, time-free; drag to arrange (pins persist)"
				>Flow</button>
			</div>
			<span class="tron-text-muted hidden text-xs md:inline">
				{mode === 'timeline'
					? 'wheel zooms · drag pans · click a node to focus its chain (Esc clears) · positions = schedule, not draggable'
					: 'drag a card to pin it · click a node to focus its chain · Esc clears'}
			</span>
		</div>
		<div class="flex items-center gap-3 text-xs">
			<label class="flex cursor-pointer items-center gap-1.5 tron-text-muted">
				<input type="checkbox" bind:checked={hideDone} /> hide done
			</label>
			{#if mode === 'flow'}
				<button type="button" class="tron-button !px-2 !py-1" onclick={relayout} title="Clear all pinned positions and re-run auto-layout">Re-layout</button>
			{/if}
		</div>
	</div>
	<div style="height: 72vh; min-height: 480px;">
		<SvelteFlow
				bind:nodes
				bind:edges
				{nodeTypes}
				fitView
				minZoom={0.08}
				maxZoom={2.2}
				onnodeclick={({ node }) => (focusId = focusId === node.id ? null : node.id)}
				onpaneclick={() => (focusId = null)}
				onnodedragstop={onDragStop}
				colorMode="dark"
			>
				<CanvasRefit signal={mode} />
				<Background bgColor="#060b14" patternColor="#152232" gap={26} />
				{#if mode === 'timeline' && backdrop}
					<ViewportPortal target="back">
						<!-- week gridlines + labels -->
						{#each backdrop.weeks as w (w.x)}
							<div style="position:absolute; left:{w.x}px; top:{BACKDROP_TOP}px; width:1px; height:{timelineLayout.totalH - BACKDROP_TOP + 60}px; background: rgba(27,42,58,0.9);"></div>
							<div style="position:absolute; left:{w.x + 4}px; top:{BACKDROP_TOP}px; font-size:10px; color:#64748b; font-family: ui-monospace, monospace;">{w.label}</div>
						{/each}
						{#each backdrop.months as mth (mth.x)}
							<div style="position:absolute; left:{mth.x + 6}px; top:{BACKDROP_TOP - 26}px; font-size:13px; font-weight:800; color:#94a3b8; letter-spacing:0.06em; text-transform:uppercase;">{mth.label}</div>
						{/each}
						<!-- today -->
						<div style="position:absolute; left:{backdrop.todayX}px; top:{BACKDROP_TOP}px; width:2px; height:{timelineLayout.totalH - BACKDROP_TOP + 60}px; background: var(--color-tron-cyan, #00d4ff); box-shadow: 0 0 10px rgba(0,212,255,0.6);"></div>
						<div style="position:absolute; left:{backdrop.todayX + 5}px; top:{BACKDROP_TOP + 16}px; font-size:11px; font-weight:800; color: var(--color-tron-cyan, #00d4ff);">today</div>
						<!-- milestone due verticals -->
						{#each backdrop.milestones as mm (mm.x)}
							<div style="position:absolute; left:{mm.x}px; top:{BACKDROP_TOP}px; width:1.5px; height:{timelineLayout.totalH - BACKDROP_TOP + 60}px; background: {mm.feasible ? 'rgba(52,211,153,0.5)' : 'rgba(248,113,113,0.55)'}; border-left: 1px dashed transparent;"></div>
						{/each}
						<!-- lane bands + labels -->
						{#each timelineLayout.lanes as L, i (L.lane)}
							{#if i % 2 === 1}
								<div style="position:absolute; left:-260px; top:{L.y}px; width:{timeScale.width + 320}px; height:{L.rows * (64 + 12) + 28}px; background: rgba(255,255,255,0.018);"></div>
							{/if}
							<div style="position:absolute; left:-240px; top:{L.y + 18}px; font-size:13px; font-weight:800; color:{tagColor(L.lane)};">{L.lane}</div>
						{/each}
					</ViewportPortal>
				{/if}
				<Controls position="bottom-left" />
				<MiniMap
					position="bottom-right"
					pannable
					zoomable
					bgColor="#0b1220"
					nodeColor={(n: Node) => ((n.data as any)?.critical ? '#f87171' : 'rgba(0,212,255,0.45)')}
					maskColor="rgba(6,11,20,0.75)"
				/>
			</SvelteFlow>
	</div>
</section>
