<script lang="ts">
	/**
	 * KB2-30 — a task on the roadmap canvas. Semantic zoom, 3 tiers with
	 * hysteresis (far: dot · mid: chip · near: full card). Dimensions are
	 * constant across tiers so edges don't re-anchor. Colors by first tag;
	 * critical chain = red border; late = red corner badge; done = faded.
	 */
	import { Handle, Position, useViewport } from '@xyflow/svelte';
	import { tagColor } from '$lib/shared/tag-color';
	import { STATUS_META, type KanbanStatus } from '$lib/shared/kanban-status';

	let { data }: { data: any } = $props();

	const viewport = useViewport();

	// Hysteresis so cards don't flicker at the boundary.
	let tier = $state<'far' | 'mid' | 'near'>('mid');
	$effect(() => {
		const z = viewport.current.zoom;
		if (tier !== 'far' && z < 0.28) tier = 'far';
		else if (tier === 'far' && z > 0.34) tier = 'mid';
		if (tier !== 'near' && z > 0.72) tier = 'near';
		else if (tier === 'near' && z < 0.66) tier = 'mid';
	});

	const color = $derived(tagColor(data.lane ?? 'untagged'));
	const statusColor = $derived(STATUS_META[data.status as KanbanStatus]?.color ?? '#94a3b8');
	const borderColor = $derived(
		data.critical && !data.done ? '#f87171' : data.done ? 'rgba(148,163,184,0.25)' : `${color}66`
	);
</script>

<div
	class="task-node"
	style="
		width: 230px; height: 64px;
		border: {data.critical && !data.done ? 2 : 1.2}px solid {borderColor};
		border-radius: 10px;
		background: {data.done ? 'rgba(30,41,59,0.35)' : 'var(--color-tron-bg-secondary, #0b1220)'};
		opacity: {data.dimmed ? 0.15 : data.done ? 0.45 : 1};
		transition: opacity 120ms ease;
		position: relative;
		overflow: hidden;
	"
	title={`${data.trackingNumber ? data.trackingNumber + ' — ' : ''}${data.title}
${data.done ? 'done' : `slack ${data.slackDays} wd · ${data.durationDays} wd (${data.estimateSource})`}`}
>
	<Handle type="target" position={Position.Left} style="opacity:0;" />
	<Handle type="source" position={Position.Right} style="opacity:0;" />

	{#if tier === 'far'}
		<div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center;">
			<div style="width: 34px; height: 34px; border-radius: 50%; background: {color}{data.done ? '33' : '99'};"></div>
		</div>
	{:else if tier === 'mid'}
		<div style="position:absolute; inset:0; display:flex; align-items:center; gap:8px; padding:0 10px;">
			<span style="width:10px; height:10px; border-radius:50%; background:{statusColor}; flex-shrink:0;"></span>
			<span style="color: var(--color-tron-text, #e2e8f0); font-size: 13px; font-weight: 600; line-height: 1.15; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">
				{data.title}
			</span>
		</div>
	{:else}
		<div style="position:absolute; inset:0; padding: 6px 10px; display:flex; flex-direction:column; justify-content:space-between;">
			<div style="display:flex; align-items:center; gap:6px; min-width:0;">
				{#if data.trackingNumber}
					<span style="font-family: ui-monospace, monospace; font-size: 9px; color: var(--color-tron-text-secondary, #64748b); flex-shrink:0;">{data.trackingNumber}</span>
				{/if}
				<a
					href="/kanban/task/{data.id}"
					style="color: var(--color-tron-text, #e2e8f0); font-size: 11.5px; font-weight: 700; line-height:1.15; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; text-decoration:none;"
					onpointerdown={(e) => e.stopPropagation()}
				>{data.title}</a>
			</div>
			<div style="display:flex; align-items:center; gap:6px; font-size: 9px;">
				<span style="color:{statusColor}; font-weight:700; text-transform:uppercase;">{STATUS_META[data.status as KanbanStatus]?.label ?? data.status}</span>
				{#if !data.done}
					<span style="color: var(--color-tron-text-secondary, #64748b);">{data.durationDays} wd ({data.estimateSource === 'explicit' ? 'est' : data.estimateSource})</span>
					<span style="color: {data.slackDays <= 5 ? '#facc15' : 'var(--color-tron-text-secondary, #64748b)'};">slack {data.slackDays}</span>
				{/if}
				<span style="margin-left:auto; width:8px; height:8px; border-radius:50%; background:{color}; flex-shrink:0;" title={data.lane}></span>
			</div>
		</div>
	{/if}

	{#if data.late && !data.done}
		<span style="position:absolute; top:0; right:0; background:#f87171; color:#0b1220; font-size:8px; font-weight:800; padding:1px 5px; border-radius:0 8px 0 6px;">LATE</span>
	{/if}
</div>
