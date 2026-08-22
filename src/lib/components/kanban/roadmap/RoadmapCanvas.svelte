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

	let {
		roadmap,
		pinned
	}: {
		roadmap: any;
		pinned: { _id: string; x: number; y: number }[];
	} = $props();

	const nodeTypes = { task: TaskNode, milestone: MilestoneNode };

	const TASK_W = 230, TASK_H = 64, MILE_W = 210, MILE_H = 104;
	const DAY_MS = 24 * 60 * 60 * 1000;
	const PX_PER_DAY = 26;
	const AXIS_H = 40; // floating axis strip height (screen px)

	let mode = $state<'timeline' | 'flow'>('timeline');
	let hideDone = $state(false);
	let fullscreen = $state(false);
	let focusId = $state<string | null>(null);
	let vp = $state({ x: 0, y: 0, zoom: 1 });
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
			durationDays: t.durationDays,
			estimateSource: t.estimateSource,
			slackDays: t.slackDays ?? null,
			critical: !parked && (critical.get(t.id) ?? false),
			late: !parked && (t.late ?? false),
			parked,
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

	// ---- timeline layout (pure derived)
	const timelineLayout = $derived.by(() => {
		const rows = [
			...graph.chainTasks.filter(({ t }) => !(hideDone && t.done)).map(({ t }) => ({ t, parked: false })),
			...graph.parkedTasks.map((t: any) => ({ t, parked: true }))
		];
		const { xOf } = timeScale;
		const laneOf = (t: any) => (t.tags ?? [])[0] ?? 'untagged';
		const laneCounts = new Map<string, number>();
		for (const { t } of rows) laneCounts.set(laneOf(t), (laneCounts.get(laneOf(t)) ?? 0) + 1);
		const laneOrder = [...laneCounts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);

		const Y0 = 0, LANE_PAD = 14, ROW_H = TASK_H + 12;
		let y = Y0;
		const lanes: { lane: string; y: number; rows: number }[] = [];
		const positions = new Map<string, { x: number; y: number }>();
		for (const lane of laneOrder) {
			const inLane = rows
				.filter(({ t }) => laneOf(t) === lane)
				.sort((a, b) => timelineDateOf(a.t).localeCompare(timelineDateOf(b.t)));
			const rowEnds: number[] = [];
			for (const { t } of inLane) {
				const x = xOf(new Date(timelineDateOf(t) + 'T00:00:00').getTime());
				let row = rowEnds.findIndex((e) => e <= x);
				if (row === -1) { row = rowEnds.length; rowEnds.push(0); }
				rowEnds[row] = x + TASK_W + 24;
				positions.set(t.id, { x, y: y + LANE_PAD + row * ROW_H });
			}
			const rowsN = Math.max(1, rowEnds.length);
			lanes.push({ lane, y, rows: rowsN });
			y += LANE_PAD * 2 + rowsN * ROW_H;
		}
		// Milestone strip: slim band directly above the top lane (KB2-35).
		graph.milestoneRows.forEach((m: any, i: number) => {
			positions.set(m.id, {
				x: xOf(new Date(m.dueDate + 'T00:00:00').getTime()) - MILE_W / 2,
				y: Y0 - MILE_H - 10 - (i % 2) * 30
			});
		});
		return { positions, lanes, totalH: y };
	});

	// ---- flow layout: dagre over the wired graph, parked grid below (KB2-34)
	const flowLayout = $derived.by(() => {
		const chain = graph.chainTasks.filter(({ t }) => !(hideDone && t.done));
		const g = new dagre.graphlib.Graph();
		g.setGraph({ rankdir: 'LR', ranksep: 110, nodesep: 26, marginx: 40, marginy: 40 });
		g.setDefaultEdgeLabel(() => ({}));
		for (const { t } of chain) g.setNode(t.id, { width: TASK_W, height: TASK_H });
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
		for (const { t } of chain) place(t.id, TASK_W, TASK_H);
		for (const m of graph.milestoneRows) place(m.id, MILE_W, MILE_H);
		// Parked grid below the graph — dagre would dump the disconnected set
		// into one giant first column (the original collapse, reborn).
		const PER_ROW = Math.max(3, Math.floor(Math.max(maxX, 1200) / (TASK_W + 30)));
		const sorted = [...graph.parkedTasks].sort((a: any, b: any) => a.rank - b.rank);
		sorted.forEach((t: any, i: number) => {
			const pin = pinMap.get(t.id);
			positions.set(
				t.id,
				pin ?? {
					x: 40 + (i % PER_ROW) * (TASK_W + 30),
					y: maxY + 110 + Math.floor(i / PER_ROW) * (TASK_H + 26)
				}
			);
		});
		return { positions, parkedBandY: maxY + 70 };
	});

	// ---- nodes/edges for SvelteFlow
	const flowData = $derived.by(() => {
		const chain = graph.chainTasks.filter(({ t }) => !(hideDone && t.done));
		const mIds = new Set(graph.milestoneRows.map((m: any) => m.id));
		const visible = new Set<string>([...chain.map(({ t }) => t.id), ...mIds]);
		const edges = graph.edges.filter((e) => visible.has(e.source) && visible.has(e.target));
		const dimmed = (id: string) => (focusSet ? !focusSet.has(id) : false);
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
			const opacity = inFocus === null ? (crit ? 0.9 : 0.3) : inFocus ? 1 : 0.06;
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
	// screen-space floating axis + lane rail (KB2-35).
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

	// Screen-space x/y for the floating axis + lane rail.
	const screenX = (canvasX: number) => vp.x + canvasX * vp.zoom;
	const screenY = (canvasY: number) => vp.y + canvasY * vp.zoom;
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
		if (focusId) focusId = null;
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
			{#if (roadmap.parked?.length ?? 0) > 0}
				<span class="rounded-full border border-slate-500/40 bg-slate-500/10 px-2 py-0.5 text-[11px] font-bold text-slate-300"
					title="Open tasks wired into no milestone chain — ghosted on the map; open one and add dependencies to wire it in">
					{roadmap.parked.length} unwired
				</span>
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
			onpaneclick={() => (focusId = null)}
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
					{#each timelineLayout.lanes as L, i (L.lane)}
						{#if i % 2 === 1}
							<div style="position:absolute; left:-260px; top:{L.y}px; width:{timeScale.width + 320}px; height:{L.rows * (64 + 12) + 28}px; background: rgba(255,255,255,0.018);"></div>
						{/if}
					{/each}
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
			<!-- KB2-35 lane rail: pinned left, tracks vertical pan only. -->
			<div class="pointer-events-none absolute inset-y-0 left-0 w-[190px] overflow-hidden" style="background: linear-gradient(to right, rgba(6,11,20,0.92) 40%, rgba(6,11,20,0));">
				{#each timelineLayout.lanes as L (L.lane)}
					<div style="position:absolute; left:8px; top:{screenY(L.y + 10)}px; font-size:12px; font-weight:800; color:{tagColor(L.lane)}; text-shadow: 0 0 6px rgba(0,0,0,0.9); white-space:nowrap;">{L.lane}</div>
				{/each}
			</div>
		{/if}
	</div>
</section>
