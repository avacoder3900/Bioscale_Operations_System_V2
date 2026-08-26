<script lang="ts">
	/**
	 * KB2-29/30/34/35 — Roadmap. Compact milestone strip → full-bleed canvas
	 * (the map gets the pixels) → must-start list → calibration footnote.
	 * All dates are computed, never stored — change them by changing links,
	 * estimates, or scope.
	 */
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import RoadmapCanvas from '$lib/components/kanban/roadmap/RoadmapCanvas.svelte';
	import KanbanModal from '$lib/components/kanban/KanbanModal.svelte';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import TronInput from '$lib/components/ui/TronInput.svelte';

	let { data } = $props();

	let mounted = $state(false);
	onMount(() => (mounted = true));

	// ---- New-milestone modal (title + hard date + the chain it waits on) ----
	let showNew = $state(false);
	let submitting = $state(false);
	let errorMsg = $state('');
	let successMsg = $state('');

	/** blocked_by selection, held as ids so a search that hides a row can't drop it. */
	let selected = $state<string[]>([]);
	let chainSearch = $state('');

	const candidates = $derived((data.linkCandidates ?? []) as any[]);
	const byId = $derived(new Map(candidates.map((t) => [t.id, t])));
	const selectedTasks = $derived(selected.map((id) => byId.get(id)).filter(Boolean) as any[]);

	const visibleCandidates = $derived.by(() => {
		const q = chainSearch.trim().toLowerCase();
		const rows = q
			? candidates.filter(
					(t) =>
						t.title.toLowerCase().includes(q) ||
						(t.trackingNumber ?? '').toLowerCase().includes(q) ||
						(t.tags ?? []).some((tag: string) => tag.toLowerCase().includes(q))
				)
			: candidates;
		return rows.slice(0, 200);
	});

	const toggle = (id: string) =>
		(selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

	function openNew() {
		errorMsg = '';
		successMsg = '';
		selected = [];
		chainSearch = '';
		showNew = true;
	}

	function newMilestoneEnhance() {
		submitting = true;
		return async ({ result, update }: { result: any; update: (opts?: any) => Promise<void> }) => {
			submitting = false;
			if (result.type === 'failure') {
				errorMsg = result.data?.error ?? 'Could not create the milestone';
				await update({ reset: false });
				return;
			}
			if (result.type === 'success') {
				errorMsg = '';
				successMsg = result.data?.createdMilestone
					? `Milestone "${result.data.createdMilestone.title}" created — the backward pass has it now.`
					: 'Milestone created.';
				showNew = false;
				selected = [];
				chainSearch = '';
			}
			await update();
		};
	}

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
	{#if errorMsg && !showNew}
		<div class="rounded border border-red-500/50 bg-red-900/20 p-2 text-xs text-red-300">{errorMsg}</div>
	{/if}
	{#if successMsg}
		<div class="rounded border border-emerald-500/40 bg-emerald-900/15 p-2 text-xs text-emerald-300">{successMsg}</div>
	{/if}

	<!-- ============ Compact milestone strip (KB2-35 — cards collapsed) ============ -->
	{#if data.roadmap.milestones.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6 text-sm tron-text-muted">
			<p>
				No dated milestones yet. A milestone is a dated anchor, not work — give it a date and wire what has
				to finish first, and the backward pass takes it from there.
			</p>
			<div class="mt-3">
				<TronButton variant="primary" onclick={openNew}>◆ New milestone</TronButton>
			</div>
			<p class="mt-3 text-xs">
				Prefer to workshop the whole plan first? Do it in the Claude app, file it with
				<span class="font-mono text-[var(--color-tron-cyan)]">kanban_file_plan</span>, and the milestones
				arrive already chained.
			</p>
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
			<button
				type="button"
				onclick={openNew}
				class="flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--color-tron-border)] px-3 py-1.5 text-sm tron-text-muted transition-all hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
				title="Add a dated milestone and wire the chain it waits on"
			>
				<span>＋</span><span>Milestone</span>
			</button>
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

<!-- ============ New milestone: title + hard date + the chain it waits on ============ -->
{#if showNew}
	<KanbanModal title="New milestone" onclose={() => (showNew = false)} maxWidth="max-w-2xl">
		<p class="tron-text-muted mb-4 text-sm">
			A milestone is a dated anchor, not work — it takes zero duration and never gets pulled. Its due date is
			the only hard date the roadmap anchors to; everything you wire below has to finish before it.
		</p>

		{#if errorMsg}
			<div class="mb-4 rounded border border-red-500/50 bg-red-900/20 p-2 text-xs text-red-300">{errorMsg}</div>
		{/if}

		<form method="POST" action="?/createMilestone" use:enhance={newMilestoneEnhance}>
			<div class="mb-4 grid gap-3 sm:grid-cols-[1fr_auto]">
				<div>
					<label for="ms-title" class="tron-label">Title</label>
					<TronInput id="ms-title" name="title" placeholder="e.g. A4M shippable" required />
				</div>
				<div>
					<label for="ms-due" class="tron-label">Due date</label>
					<input id="ms-due" name="dueDate" type="date" class="tron-input w-full" required />
				</div>
			</div>

			<div class="mb-4">
				<label for="ms-tags" class="tron-label">Tags (comma-separated, optional)</label>
				<input id="ms-tags" name="tags" class="tron-input w-full" autocomplete="off" placeholder="software, hardware…" />
			</div>

			<div class="mb-4">
				<label for="ms-desc" class="tron-label">What does hitting this milestone mean? (optional)</label>
				<textarea id="ms-desc" name="description" class="tron-input w-full" rows="2"></textarea>
			</div>

			<!-- Chain picker → blocked_by links, wired at birth -->
			<div class="mb-4">
				<div class="mb-2 flex items-baseline justify-between gap-3">
					<span class="tron-label mb-0">What must finish before this milestone?</span>
					<span class="tron-text-muted text-xs">{selected.length} selected</span>
				</div>

				{#each selectedTasks as t (t.id)}
					<input type="hidden" name="blockedBy" value={t.id} />
				{/each}

				{#if selectedTasks.length}
					<div class="mb-2 flex flex-wrap gap-1.5">
						{#each selectedTasks as t (t.id)}
							<button
								type="button"
								onclick={() => toggle(t.id)}
								class="flex items-center gap-1.5 rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-xs text-[var(--color-tron-cyan)]"
								title="Remove from the chain"
							>
								<span class="max-w-[220px] truncate">{t.title}</span><span>×</span>
							</button>
						{/each}
					</div>
				{/if}

				<input
					class="tron-input mb-2 w-full"
					placeholder="Filter by title, tracking number, or tag…"
					autocomplete="off"
					bind:value={chainSearch}
				/>

				<div
					class="max-h-56 overflow-y-auto rounded border"
					style="border-color: var(--color-tron-border); background: var(--color-tron-bg-secondary);"
				>
					{#each visibleCandidates as t (t.id)}
						<label
							class="flex cursor-pointer items-center gap-2 border-b border-[var(--color-tron-border)]/40 px-2 py-1.5 text-xs last:border-b-0 hover:bg-[var(--color-tron-bg-tertiary)]"
						>
							<input
								type="checkbox"
								checked={selected.includes(t.id)}
								onchange={() => toggle(t.id)}
								class="shrink-0"
							/>
							{#if t.itemType === 'milestone'}<span class="shrink-0 text-[var(--color-tron-cyan)]">◆</span>{/if}
							{#if t.trackingNumber}
								<span class="tron-text-muted shrink-0 font-mono">{t.trackingNumber}</span>
							{/if}
							<span class="tron-text-primary truncate">{t.title}</span>
							<span class="tron-text-muted ml-auto shrink-0 uppercase">{t.status}</span>
						</label>
					{:else}
						<div class="tron-text-muted p-3 text-xs">
							{candidates.length ? 'Nothing matches that filter.' : 'No open tasks to wire yet.'}
						</div>
					{/each}
				</div>
				<p class="tron-text-muted mt-1 text-[11px]">
					Optional now — you can also draw dependencies straight onto the canvas later. Done and declined
					work is left out: gating on it anchors nothing.
				</p>
			</div>

			<div class="flex justify-end gap-3">
				<TronButton onclick={() => (showNew = false)}>Cancel</TronButton>
				<TronButton type="submit" variant="primary" disabled={submitting}>
					{submitting ? 'Creating…' : 'Create milestone'}
				</TronButton>
			</div>
		</form>
	</KanbanModal>
{/if}
