<script lang="ts">
	/**
	 * KB2-30 — the infinite-zoom dependency canvas (replaced the KB2-29
	 * swimlane timeline). Svelte Flow viewport + dagre LR auto-layout for
	 * unpinned nodes; pinned positions win. Focus mode: click a node → its
	 * full upstream/downstream chain stays lit, everything else dims; click
	 * the pane or Esc to clear. Dragging a node persists its position
	 * (?/pinNode — shared layout, Miro model).
	 */
	import { SvelteFlow, Background, Controls, MiniMap } from '@xyflow/svelte';
	import type { Node, Edge } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import dagre from '@dagrejs/dagre';
	import TaskNode from './TaskNode.svelte';
	import MilestoneNode from './MilestoneNode.svelte';
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

	let hideDone = $state(false);
	let focusId = $state<string | null>(null);
	// Local pin map — updated on drag so rebuilds (focus/hideDone) keep positions.
	// svelte-ignore state_referenced_locally — deliberate: seed once from the
	// load data; afterwards drags/relayout own it (a live $derived would wipe
	// optimistic pins on every invalidate).
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
		// edges from blockedBy (all preds) + task→milestone sinks
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

	// ---- layout + nodes/edges for SvelteFlow
	const flowData = $derived.by(() => {
		const doneHidden = (id: string, done: boolean) => hideDone && done;
		const tasks = graph.tasks.filter(({ t }) => !doneHidden(t.id, t.done));
		const mIds = new Set(graph.milestoneRows.map((m: any) => m.id));
		const visible = new Set<string>([...tasks.map(({ t }) => t.id), ...mIds]);
		const edges = graph.edges.filter((e) => visible.has(e.source) && visible.has(e.target));

		// dagre for everything; pinned positions override after.
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

		const dimmed = (id: string) => (focusSet ? !focusSet.has(id) : false);
		const critical = new Map(graph.tasks.map(({ t }) => [t.id, t.onCriticalChain && !t.done]));

		const nodes: Node[] = [
			...tasks.map(({ t }) => ({
				id: t.id,
				type: 'task',
				position: pos(t.id, TASK_W, TASK_H),
				draggable: true,
				data: {
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
					dimmed: dimmed(t.id)
				}
			})),
			...graph.milestoneRows.map((m: any) => ({
				id: m.id,
				type: 'milestone',
				position: pos(m.id, MILE_W, MILE_H),
				draggable: true,
				data: {
					id: m.id,
					title: m.title,
					shortTitle: m.title.replace(/^MILESTONE:\s*/i, ''),
					dueDate: m.dueDate,
					bufferDays: m.bufferDays,
					feasible: m.feasible,
					dimmed: dimmed(m.id)
				}
			}))
		];

		const flowEdges: Edge[] = edges.map((e) => {
			const crit = (critical.get(e.source) ?? false) && ((critical.get(e.target) ?? false) || mIds.has(e.target));
			const dim = focusSet ? !(focusSet.has(e.source) && focusSet.has(e.target)) : false;
			return {
				id: `${e.source}→${e.target}`,
				source: e.source,
				target: e.target,
				type: 'smoothstep',
				animated: crit && !dim,
				style: `stroke: ${crit ? '#f87171' : 'rgba(0,212,255,0.35)'}; stroke-width: ${crit ? 2.2 : 1.4}; opacity: ${dim ? 0.08 : 1};`
			};
		});

		return { nodes, edges: flowEdges };
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
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') focusId = null; }} />

<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
	<div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-tron-border)] px-4 py-2">
		<div class="text-sm font-bold tron-text-primary">
			Dependency map
			<span class="tron-text-muted font-normal">— wheel zooms, drag pans, drag a card to pin it; click a node to focus its chain, Esc to clear</span>
		</div>
		<div class="flex items-center gap-3 text-xs">
			<label class="flex cursor-pointer items-center gap-1.5 tron-text-muted">
				<input type="checkbox" bind:checked={hideDone} /> hide done
			</label>
			<button type="button" class="tron-button !px-2 !py-1" onclick={relayout} title="Clear all pinned positions and re-run auto-layout">Re-layout</button>
		</div>
	</div>
	<div style="height: 72vh; min-height: 480px;">
		<SvelteFlow
			bind:nodes
			bind:edges
			{nodeTypes}
			fitView
			minZoom={0.1}
			maxZoom={2.2}
			proOptions={{ hideAttribution: false }}
			onnodeclick={({ node }) => (focusId = focusId === node.id ? null : node.id)}
			onpaneclick={() => (focusId = null)}
			onnodedragstop={onDragStop}
			colorMode="dark"
		>
			<Background bgColor="#060b14" patternColor="#1b2a3a" gap={26} />
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
