<script lang="ts">
	/**
	 * KB2-30/35 — a milestone sink on the canvas: diamond + date + buffer.
	 * The name counter-scales (min(18, 12/zoom)px → ~12px effective at any
	 * distance) so milestones stay readable from every altitude.
	 */
	import { Handle, Position, useViewport } from '@xyflow/svelte';

	let { data }: { data: any } = $props();
	const viewport = useViewport();
	const tone = $derived(data.feasible ? '#34d399' : '#f87171');
	const nameSize = $derived(Math.min(18, 12 / Math.max(0.15, viewport.current.zoom)));
	const subSize = $derived(Math.min(14, 9.5 / Math.max(0.15, viewport.current.zoom)));
</script>

<div
	style="width: 210px; height: 104px; position: relative; opacity: {data.dimmed ? 0.15 : 1}; transition: opacity 120ms ease; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px;"
	title={data.title}
>
	<Handle type="target" position={Position.Left} style="opacity:0;" />
	<Handle type="source" position={Position.Right} style="opacity:0;" />

	<!-- Corner jump to the milestone's task page (same affordance as task cards). -->
	<a
		class="open-link"
		href="/kanban/task/{data.id}"
		aria-label="Open milestone details"
		title="Open milestone details"
		onpointerdown={(e) => e.stopPropagation()}
		onclick={(e) => e.stopPropagation()}
	>↗</a>

	{#if data.onPort}
		<button
			type="button"
			aria-label="gated by…"
			title="gated by… (click, then click the RIGHT ○ of a task that must finish before this milestone)"
			style="position:absolute; left:-4px; top:50%; transform:translateY(-50%); width:14px; height:14px; border-radius:50%; border:2px solid {data.pendingPort === 'left' ? '#00d4ff' : 'rgba(0,212,255,0.55)'}; background:{data.pendingPort === 'left' ? '#00d4ff' : '#0b1220'}; box-shadow:{data.pendingPort === 'left' ? '0 0 10px #00d4ff' : 'none'}; cursor:pointer; z-index:5; padding:0;"
			onpointerdown={(e) => e.stopPropagation()}
			onclick={(e) => { e.stopPropagation(); data.onPort(data.id, 'left'); }}
		></button>
		<button
			type="button"
			aria-label="unlocks…"
			title="unlocks… (click, then click the LEFT ○ of a task that starts after this milestone)"
			style="position:absolute; right:-4px; top:50%; transform:translateY(-50%); width:14px; height:14px; border-radius:50%; border:2px solid {data.pendingPort === 'right' ? '#00d4ff' : 'rgba(0,212,255,0.55)'}; background:{data.pendingPort === 'right' ? '#00d4ff' : '#0b1220'}; box-shadow:{data.pendingPort === 'right' ? '0 0 10px #00d4ff' : 'none'}; cursor:pointer; z-index:5; padding:0;"
			onpointerdown={(e) => e.stopPropagation()}
			onclick={(e) => { e.stopPropagation(); data.onPort(data.id, 'right'); }}
		></button>
	{/if}
	<div style="width: 40px; height: 40px; transform: rotate(45deg); background: {tone}22; border: 3px solid {tone}; border-radius: 7px; box-shadow: 0 0 22px {tone}66;"></div>
	<div style="text-align:center; white-space: nowrap;">
		<div style="color: {tone}; font-weight: 800; font-size: {nameSize}px; line-height:1.1; text-shadow: 0 0 8px rgba(0,0,0,0.9);">{data.shortTitle}</div>
		<div style="color: #94a3b8; font-size: {subSize}px; font-family: ui-monospace, monospace;">
			{data.dueDate} · {data.feasible ? `${data.bufferDays} wd buffer` : `${-data.bufferDays} wd OVER`}
		</div>
	</div>
</div>

<style>
	.open-link {
		position: absolute;
		top: 3px;
		right: 3px;
		z-index: 6;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 17px;
		height: 17px;
		border-radius: 5px;
		font-size: 11px;
		font-weight: 700;
		color: #7b8ba3;
		background: rgba(11, 18, 32, 0.65);
		text-decoration: none;
	}
	.open-link:hover {
		color: #00d4ff;
		background: rgba(0, 212, 255, 0.14);
	}
</style>
