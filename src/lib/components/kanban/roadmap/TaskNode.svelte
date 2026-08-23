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

	// Hysteresis so cards don't flicker at the boundary. KB2-35 retune: chips
	// only appear once their text is ≥~7px effective; full cards from 0.8.
	let tier = $state<'far' | 'mid' | 'near'>('mid');
	$effect(() => {
		const z = viewport.current.zoom;
		if (tier !== 'far' && z < 0.42) tier = 'far';
		else if (tier === 'far' && z > 0.48) tier = 'mid';
		if (tier !== 'near' && z > 0.82) tier = 'near';
		else if (tier === 'near' && z < 0.76) tier = 'mid';
	});

	const color = $derived(tagColor(data.lane ?? 'untagged'));
	// KB2-36: tags render on the card — primary as a left-edge stripe, the
	// rest as small dots (lanes were lossy for multi-tag tasks).
	const extraTags = $derived(((data.tags ?? []) as string[]).slice(1, 4));
	const statusColor = $derived(STATUS_META[data.status as KanbanStatus]?.color ?? '#94a3b8');
	const borderColor = $derived(
		data.parked
			? 'rgba(148,163,184,0.45)'
			: data.critical && !data.done
				? '#f87171'
				: data.done
					? 'rgba(148,163,184,0.25)'
					: `${color}88`
	);
</script>

<div
	class="task-node"
	style="
		width: 230px; height: 64px;
		border: {data.critical && !data.done && !data.parked ? 2 : 1.2}px {data.parked ? 'dashed' : 'solid'} {borderColor};
		border-radius: 10px;
		background: {data.done ? 'rgba(30,41,59,0.35)' : data.parked ? 'rgba(20,28,42,0.7)' : 'var(--color-tron-bg-secondary, #0b1220)'};
		opacity: {data.dimmed ? 0.15 : data.done ? 0.45 : data.parked ? 0.6 : 1};
		transition: opacity 120ms ease;
		position: relative;
		overflow: hidden;
		border-left: 4px solid {data.parked ? 'rgba(148,163,184,0.5)' : color};
	"
	title={`${data.trackingNumber ? data.trackingNumber + ' — ' : ''}${data.title}
${data.parked ? 'UNWIRED — in no milestone chain; open the task to add dependencies' : data.done ? 'done' : `slack ${data.slackDays} wd · ${data.durationDays} wd (${data.estimateSource})`}`}
>
	<Handle type="target" position={Position.Left} style="opacity:0;" />
	<Handle type="source" position={Position.Right} style="opacity:0;" />

	{#if tier !== 'far' && data.onPort}
		<!-- KB2-37 click-to-connect ports: left = "starts after…", right = "must
		     finish before…". stopPropagation so focus mode never fires. -->
		<button
			type="button"
			aria-label="starts after…"
			title="starts after… (click, then click the RIGHT ○ of the task that comes before)"
			style="position:absolute; left:-8px; top:50%; transform:translateY(-50%); width:14px; height:14px; border-radius:50%; border:2px solid {data.pendingPort === 'left' ? '#00d4ff' : 'rgba(0,212,255,0.55)'}; background:{data.pendingPort === 'left' ? '#00d4ff' : '#0b1220'}; box-shadow:{data.pendingPort === 'left' ? '0 0 10px #00d4ff' : 'none'}; cursor:pointer; z-index:5; padding:0;"
			onpointerdown={(e) => e.stopPropagation()}
			onclick={(e) => { e.stopPropagation(); data.onPort(data.id, 'left'); }}
		></button>
		<button
			type="button"
			aria-label="must finish before…"
			title="must finish before… (click, then click the LEFT ○ of the task that comes after)"
			style="position:absolute; right:-8px; top:50%; transform:translateY(-50%); width:14px; height:14px; border-radius:50%; border:2px solid {data.pendingPort === 'right' ? '#00d4ff' : 'rgba(0,212,255,0.55)'}; background:{data.pendingPort === 'right' ? '#00d4ff' : '#0b1220'}; box-shadow:{data.pendingPort === 'right' ? '0 0 10px #00d4ff' : 'none'}; cursor:pointer; z-index:5; padding:0;"
			onpointerdown={(e) => e.stopPropagation()}
			onclick={(e) => { e.stopPropagation(); data.onPort(data.id, 'right'); }}
		></button>
	{/if}

	{#if tier === 'far'}
		<div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center;">
			<div style="width: 34px; height: 34px; border-radius: 50%; background: {color}{data.done ? '33' : '99'};"></div>
		</div>
	{:else if tier === 'mid'}
		<div style="position:absolute; inset:0; display:flex; align-items:center; gap:8px; padding:0 10px;">
			<span style="width:10px; height:10px; border-radius:50%; background:{statusColor}; flex-shrink:0;"></span>
			<span style="color: #f1f5f9; font-size: 14px; font-weight: 600; line-height: 1.15; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">
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
					style="color: #f1f5f9; font-size: 12px; font-weight: 700; line-height:1.15; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; text-decoration:none;"
					onpointerdown={(e) => e.stopPropagation()}
				>{data.title}</a>
			</div>
			<div style="display:flex; align-items:center; gap:6px; font-size: 9px;">
				<span style="color:{statusColor}; font-weight:700; text-transform:uppercase;">{STATUS_META[data.status as KanbanStatus]?.label ?? data.status}</span>
				{#if data.parked}
					<span style="color:#94a3b8; font-weight:700; letter-spacing:0.04em;">UNWIRED</span>
					<span style="color: var(--color-tron-text-secondary, #64748b);">{data.durationDays} wd</span>
				{:else if !data.done}
					<span style="color: var(--color-tron-text-secondary, #64748b);">{data.durationDays} wd ({data.estimateSource === 'explicit' ? 'est' : data.estimateSource})</span>
					<span style="color: {data.slackDays <= 5 ? '#facc15' : 'var(--color-tron-text-secondary, #64748b)'};">slack {data.slackDays}</span>
				{/if}
				<span style="margin-left:auto; display:flex; gap:3px; flex-shrink:0;" title={(data.tags ?? []).join(' · ')}>
					<span style="width:8px; height:8px; border-radius:50%; background:{color};"></span>
					{#each extraTags as tg (tg)}
						<span style="width:8px; height:8px; border-radius:50%; background:{tagColor(tg)};"></span>
					{/each}
				</span>
			</div>
		</div>
	{/if}

	{#if data.late && !data.done}
		<span style="position:absolute; top:0; right:0; background:#f87171; color:#0b1220; font-size:8px; font-weight:800; padding:1px 5px; border-radius:0 8px 0 6px;">LATE</span>
	{/if}
</div>
