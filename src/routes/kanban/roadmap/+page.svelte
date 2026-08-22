<script lang="ts">
	/**
	 * KB2-29/30/34/35 — Roadmap. Compact milestone strip → full-bleed canvas
	 * (the map gets the pixels) → must-start list → calibration footnote.
	 * All dates are computed, never stored — change them by changing links,
	 * estimates, or scope.
	 */
	import { onMount } from 'svelte';
	import RoadmapCanvas from '$lib/components/kanban/roadmap/RoadmapCanvas.svelte';

	let { data } = $props();

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
	const cycleErrors = $derived(data.roadmap.milestones.filter((m: any) => m.cycleError));
</script>

<svelte:head><title>Roadmap — Kanban</title></svelte:head>

<div class="space-y-4">
	<!-- ============ Compact milestone strip (KB2-35 — cards collapsed) ============ -->
	{#if data.roadmap.milestones.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6 text-sm tron-text-muted">
			No dated milestones yet. Workshop the plan in the Claude app, file it with
			<span class="font-mono text-[var(--color-tron-cyan)]">kanban_file_plan</span>, then capture milestone tasks
			(<span class="font-mono">itemType: 'milestone'</span> + a due date) and wire their
			<span class="font-mono">blocked_by</span> chains.
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-2">
			{#each data.roadmap.milestones as m (m.id)}
				<a
					href="/kanban/task/{m.id}"
					class="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-all hover:bg-[var(--color-tron-bg-tertiary)] {m.feasible ? 'border-[var(--color-tron-border)]' : 'border-red-500/60'}"
					title={`${m.title}
due ${m.dueDate} · projected ${m.projectedFinish}${m.clampFinish && m.clampFinish > m.cpmFinish ? ' (capacity-limited)' : ''}
${Math.round(m.chainPctByDays * 100)}% of chain done · ${m.daysLeft} wd left${m.feasible ? '' : '\nNOT REACHABLE at current pace — cut scope, add capacity, or move the date'}`}
				>
					<span style="color: {m.feasible ? '#34d399' : '#f87171'};">◆</span>
					<span class="tron-text-primary font-bold">{m.title.replace(/^MILESTONE:\s*/i, '')}</span>
					<span class="font-mono text-xs tron-text-muted">{fmt(m.dueDate)}</span>
					<span class="rounded px-1.5 py-0.5 text-xs font-bold {m.feasible ? (m.bufferDays <= 5 ? 'bg-yellow-900/40 text-yellow-300' : 'bg-emerald-900/40 text-emerald-300') : 'bg-red-900/50 text-red-300'}">
						{m.feasible ? `+${m.bufferDays} wd` : `${m.bufferDays} wd ⚠`}
					</span>
				</a>
			{/each}
			{#if data.roadmap.milestones.some((m: any) => !m.feasible)}
				<span class="text-xs text-red-300">⚠ not reachable at current pace — cut scope, add capacity, or move the date</span>
			{/if}
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
	{#each cycleErrors as m (m.id)}
		<div class="rounded border border-yellow-500/40 bg-yellow-900/15 p-2 text-xs text-yellow-300">{m.title}: {m.cycleError}</div>
	{/each}

	<!-- ============ The canvas — full-bleed (KB2-35) ============ -->
	{#if data.roadmap.milestones.length > 0}
		<div style="margin-left: calc(50% - 50vw); margin-right: calc(50% - 50vw);">
			{#if mounted}
				<RoadmapCanvas roadmap={data.roadmap} pinned={data.pinned} />
			{:else}
				<div class="flex h-[78vh] min-h-[520px] items-center justify-center border-y border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] text-sm tron-text-muted">
					Loading canvas…
				</div>
			{/if}
		</div>
	{/if}

	<!-- ============ Must-start (daily driver) ============ -->
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

	<!-- calibration footnote -->
	<p class="px-1 text-[11px] tron-text-muted">
		{#if cal.n > 0 && cal.medianActualOverEstimate}
			Estimate calibration: your explicit estimates run ~{cal.medianActualOverEstimate.toFixed(1)}× actual (n={cal.n}).
		{:else}
			No estimate-vs-actual history yet — calibration appears once estimated tasks complete.
		{/if}
		Velocity: {data.roadmap.velocityDaysPerWeek ? `${data.roadmap.velocityDaysPerWeek.toFixed(1)} est-days/week` : 'none — capacity clamp off'}
		(source: {data.roadmap.velocitySource}{data.roadmap.measuredVelocityDaysPerWeek != null && data.roadmap.velocitySource !== 'measured' ? ` — board measures ${data.roadmap.measuredVelocityDaysPerWeek.toFixed(1)}` : ''}; n={data.roadmap.velocitySampleN} estimated completions in the trailing window).
		{#if (data.roadmap.resolvedCapacitySchedule?.length ?? 0) > 1}
			Capacity schedule: {data.roadmap.resolvedCapacitySchedule.map((s: any) => `${s.from} → ${s.teamEstDaysPerWeek}/wk`).join(', ')}.
		{/if}
		Unsized default: {data.roadmap.medianCycleDays} wd.
		{data.roadmap.parked?.length ?? 0} unwired tasks queue behind chain work — wire them via each task's Dependencies panel.
		All future dates are computed, never stored.
	</p>
</div>
