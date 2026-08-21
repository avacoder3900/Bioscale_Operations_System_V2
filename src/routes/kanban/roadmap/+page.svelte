<script lang="ts">
	/**
	 * KB2-29/KB2-30 — Roadmap: countdown cards + must-start list (the daily
	 * drivers) above the infinite-zoom dependency canvas (KB2-30 — replaced
	 * the swimlane timeline 2026-08-20; a timeline can't show the graph, and
	 * the graph is what the plan is). All dates are computed, never stored —
	 * change them by changing links, estimates, or scope.
	 */
	import { onMount } from 'svelte';
	import RoadmapCanvas from '$lib/components/kanban/roadmap/RoadmapCanvas.svelte';

	let { data } = $props();

	// Svelte Flow is a browser-only canvas — mount it client-side.
	let mounted = $state(false);
	onMount(() => (mounted = true));

	const allMustStart = $derived(
		data.roadmap.milestones
			.flatMap((m: any) => m.mustStart)
			.sort((a: any, b: any) => a.slackDays - b.slackDays || a.rank - b.rank)
	);

	const fmt = (isoDate: string) =>
		new Date(isoDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	const cal = $derived(data.roadmap.calibration);
</script>

<svelte:head><title>Roadmap — Kanban</title></svelte:head>

<div class="space-y-6">
	<!-- ======================= Milestone countdown headers ======================= -->
	{#if data.roadmap.milestones.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6 text-sm tron-text-muted">
			No dated milestones yet. Workshop the plan in the Claude app, file it with
			<span class="font-mono text-[var(--color-tron-cyan)]">kanban_file_plan</span>, then capture milestone tasks
			(<span class="font-mono">itemType: 'milestone'</span> + a due date) and wire their
			<span class="font-mono">blocked_by</span> chains. The backward pass takes it from there.
		</div>
	{:else}
		<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
			{#each data.roadmap.milestones as m (m.id)}
				<div class="rounded-lg border p-4 {m.feasible ? 'border-[var(--color-tron-border)]' : 'border-red-500/60'} bg-[var(--color-tron-bg-secondary)]">
					<div class="flex items-baseline justify-between gap-2">
						<a href="/kanban/task/{m.id}" class="tron-text-primary text-sm font-bold hover:underline">◆ {m.title}</a>
						<span class="text-xs font-mono tron-text-muted">{fmt(m.dueDate)}</span>
					</div>
					<div class="mt-2 flex items-center gap-4 text-xs">
						<span class="tron-text-muted">{m.daysLeft} wd left</span>
						<span class="tron-text-muted">{Math.round(m.chainPctByDays * 100)}% of chain done</span>
						<span class="font-bold {m.feasible ? (m.bufferDays <= 5 ? 'text-yellow-400' : 'text-green-400') : 'text-red-400'}">
							{m.feasible ? `${m.bufferDays} wd buffer` : `${-m.bufferDays} wd OVER`}
						</span>
					</div>
					<div class="mt-1 text-[11px] tron-text-muted">
						projected {fmt(m.projectedFinish)}{m.clampFinish && m.clampFinish > m.cpmFinish ? ' (capacity-limited)' : ''}
					</div>
					{#if !m.feasible}
						<div class="mt-2 rounded border border-red-500/40 bg-red-900/15 p-2 text-[11px] text-red-300">
							Not reachable at current pace — cut scope, add capacity, or move the date.
						</div>
					{/if}
					{#if m.cycleError}
						<div class="mt-2 rounded border border-yellow-500/40 bg-yellow-900/15 p-2 text-[11px] text-yellow-300">{m.cycleError}</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	{#if data.roadmap.unscheduledMilestones.length}
		<div class="rounded border border-yellow-500/40 bg-yellow-900/10 p-2 text-xs text-yellow-300">
			Milestones without a due date (not scheduled):
			{#each data.roadmap.unscheduledMilestones as u, i (u.id)}
				{i > 0 ? ' · ' : ''}<a href="/kanban/task/{u.id}" class="underline">{u.title}</a>
			{/each}
		</div>
	{/if}

	<!-- ======================= Must-start (daily driver) ======================= -->
	{#if allMustStart.length}
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
			<div class="border-b border-[var(--color-tron-border)] px-4 py-2 text-sm font-bold tron-text-primary">
				Must start <span class="tron-text-muted font-normal">— unblocked, latest start now or near; slack ↑, Tier 1 rank breaks ties</span>
			</div>
			<div class="divide-y divide-[var(--color-tron-border)]">
				{#each allMustStart as t (t.id + t.milestoneId)}
					<div class="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
						<span class="w-16 shrink-0 text-center rounded px-1.5 py-0.5 text-[11px] font-bold {t.late ? 'bg-red-900/40 text-red-300' : 'bg-yellow-900/30 text-yellow-300'}">
							{t.late ? 'LATE' : `${t.slackDays} wd`}
						</span>
						<a href="/kanban/task/{t.id}" class="tron-text-primary min-w-[200px] flex-1 font-medium hover:underline">
							{#if t.trackingNumber}<span class="font-mono text-xs tron-text-muted">{t.trackingNumber}</span>{/if}
							{t.title}
						</a>
						<span class="text-xs tron-text-muted">start by {fmt(t.lateStart)}</span>
						<span class="text-xs tron-text-muted">→ ◆ {t.milestoneTitle}</span>
						<span class="text-xs tron-text-muted">#{t.rank}</span>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<!-- ======================= The canvas (KB2-30) ======================= -->
	{#if data.roadmap.milestones.length > 0}
		{#if mounted}
			<RoadmapCanvas roadmap={data.roadmap} pinned={data.pinned} />
		{:else}
			<div class="flex h-[72vh] min-h-[480px] items-center justify-center rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] text-sm tron-text-muted">
				Loading canvas…
			</div>
		{/if}
	{/if}

	<!-- calibration footnote -->
	<p class="px-1 text-[11px] tron-text-muted">
		{#if cal.n > 0 && cal.medianActualOverEstimate}
			Estimate calibration: your explicit estimates run ~{cal.medianActualOverEstimate.toFixed(1)}× actual (n={cal.n}).
		{:else}
			No estimate-vs-actual history yet — calibration appears once estimated tasks complete.
		{/if}
		Velocity: {data.roadmap.velocityDaysPerWeek ? `${data.roadmap.velocityDaysPerWeek.toFixed(1)} estimate-days/week (8-wk mean)` : 'no history — capacity clamp off'}.
		Unsized default: {data.roadmap.medianCycleDays} wd.
		All future dates are computed, never stored — change them by changing links, estimates, or scope.
	</p>
</div>
