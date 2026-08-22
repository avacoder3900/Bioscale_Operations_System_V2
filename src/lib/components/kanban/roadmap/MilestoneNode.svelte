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
	<div style="width: 40px; height: 40px; transform: rotate(45deg); background: {tone}22; border: 3px solid {tone}; border-radius: 7px; box-shadow: 0 0 22px {tone}66;"></div>
	<div style="text-align:center; white-space: nowrap;">
		<div style="color: {tone}; font-weight: 800; font-size: {nameSize}px; line-height:1.1; text-shadow: 0 0 8px rgba(0,0,0,0.9);">{data.shortTitle}</div>
		<div style="color: #94a3b8; font-size: {subSize}px; font-family: ui-monospace, monospace;">
			{data.dueDate} · {data.feasible ? `${data.bufferDays} wd buffer` : `${-data.bufferDays} wd OVER`}
		</div>
	</div>
</div>
