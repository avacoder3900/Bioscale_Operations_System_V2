<script lang="ts">
	/** KB2-30 — a milestone sink on the canvas: diamond + date + buffer state. */
	import { Handle, Position } from '@xyflow/svelte';

	let { data }: { data: any } = $props();
	const tone = $derived(data.feasible ? '#34d399' : '#f87171');
</script>

<div
	style="width: 210px; height: 96px; position: relative; opacity: {data.dimmed ? 0.15 : 1}; transition: opacity 120ms ease; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px;"
	title={data.title}
>
	<Handle type="target" position={Position.Left} style="opacity:0;" />
	<Handle type="source" position={Position.Right} style="opacity:0;" />
	<div style="width: 34px; height: 34px; transform: rotate(45deg); background: {tone}22; border: 2.5px solid {tone}; border-radius: 6px; box-shadow: 0 0 18px {tone}55;"></div>
	<div style="text-align:center;">
		<div style="color: {tone}; font-weight: 800; font-size: 12px; line-height:1.1;">{data.shortTitle}</div>
		<div style="color: var(--color-tron-text-secondary, #64748b); font-size: 10px; font-family: ui-monospace, monospace;">
			{data.dueDate} · {data.feasible ? `${data.bufferDays} wd buffer` : `${-data.bufferDays} wd OVER`}
		</div>
	</div>
</div>
