<!--
  /manufacturing/cart-mfg/robots — the Robots page (ROBOT-OVERHAUL round 3).
  The board (every OT-2, wax + reagent, health, restart/reset) is rendered by
  the (robots) layout above; this page renders EVERY robot's wizard below it,
  side by side, one panel per robot, always open. Each panel's header has a
  Wax | Reagent toggle; it is locked while that robot has a run in progress.
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { resolve } from '$app/paths';
	import WaxWizard from '$lib/components/manufacturing/wax-filling/WaxWizard.svelte';
	import ReagentWizard from '$lib/components/manufacturing/reagent-filling/ReagentWizard.svelte';
	import ReagentWellHeatmap from '$lib/components/manufacturing/reagent-filling/ReagentWellHeatmap.svelte';
	import { parseOpenPanels, panelsHref, type BoardProcess } from '$lib/manufacturing/robot-panels';
	import type { WellIssueHeatmap } from '$lib/server/manufacturing/reagent-well-heatmap';

	let { data } = $props();

	const openMap = $derived(parseOpenPanels($page.url.searchParams.get('open')));
	const count = $derived(data.panels.length);
	const gridClass = $derived(count >= 3 ? 'xl:grid-cols-3' : count === 2 ? 'xl:grid-cols-2' : '');
	const PROCESSES: BoardProcess[] = ['wax', 'reagent'];
	const label = (p: BoardProcess) => (p === 'wax' ? 'Wax' : 'Reagent');

	// ── inline heatmap card (2026-10-08): the icon opens this robot's reagent
	//    fill-mistake heatmap ABOVE the wizard, fetched on first open, instead of
	//    leaving the page. Per robot: closed | loading | loaded | error.
	const HEATMAP_DAYS = 30;
	type HeatmapState = { open: boolean; loading: boolean; error: string; data: WellIssueHeatmap | null };
	let heatmaps = $state<Record<string, HeatmapState>>({});
	const heatmapOf = (robotId: string): HeatmapState => heatmaps[robotId] ?? { open: false, loading: false, error: '', data: null };

	async function toggleHeatmap(robotId: string) {
		const cur = heatmapOf(robotId);
		if (cur.open) {
			heatmaps = { ...heatmaps, [robotId]: { ...cur, open: false } };
			return;
		}
		heatmaps = { ...heatmaps, [robotId]: { ...cur, open: true, loading: cur.data === null, error: '' } };
		if (cur.data !== null) return;
		await loadHeatmap(robotId);
	}

	async function loadHeatmap(robotId: string) {
		heatmaps = { ...heatmaps, [robotId]: { ...heatmapOf(robotId), loading: true, error: '' } };
		try {
			const res = await fetch(`/api/manufacturing/reagent-well-issues?robot=${encodeURIComponent(robotId)}&days=${HEATMAP_DAYS}`, { credentials: 'same-origin' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as WellIssueHeatmap;
			heatmaps = { ...heatmaps, [robotId]: { ...heatmapOf(robotId), loading: false, data: body } };
		} catch (e) {
			heatmaps = { ...heatmaps, [robotId]: { ...heatmapOf(robotId), loading: false, error: e instanceof Error ? e.message : 'Could not load the heatmap' } };
		}
	}
</script>

{#if count === 0}
	<p class="text-sm text-[var(--color-tron-text-secondary)]">No active robots — add one under Equipment.</p>
{:else}
	<div class="grid grid-cols-1 gap-4 {gridClass}">
		{#each data.panels as panel (panel.robotId)}
			{@const hm = heatmapOf(panel.robotId)}
			<section
				id="panel-{panel.robotId}"
				class="min-w-0 scroll-mt-20 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]/40 p-3"
				aria-label="{panel.robotName} {panel.process} filling"
			>
				<header class="mb-3 flex items-center justify-between gap-2 border-b border-[var(--color-tron-border)] pb-2">
					<h2 class="truncate text-sm font-semibold text-[var(--color-tron-text)]">{panel.robotName}</h2>
					<div class="flex shrink-0 items-center gap-1.5">
					<!-- This robot's reagent fill-mistake heatmap (the per-well tracker's
					     history) — opens as a card above the wizard, not a new page. -->
					<button
						type="button"
						onclick={() => toggleHeatmap(panel.robotId)}
						class="flex h-6 w-6 items-center justify-center rounded border transition-colors {hm.open
							? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]'
							: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}"
						title="{panel.robotName}: reagent fill mistakes by position (heatmap), last {HEATMAP_DAYS} days"
						aria-label="{panel.robotName} well-issue heatmap"
						aria-pressed={hm.open}
					>
						<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
							<rect x="3" y="3" width="5" height="5" rx="1" opacity="0.35" />
							<rect x="9.5" y="3" width="5" height="5" rx="1" opacity="0.7" />
							<rect x="16" y="3" width="5" height="5" rx="1" />
							<rect x="3" y="9.5" width="5" height="5" rx="1" opacity="0.7" />
							<rect x="9.5" y="9.5" width="5" height="5" rx="1" />
							<rect x="16" y="9.5" width="5" height="5" rx="1" opacity="0.35" />
							<rect x="3" y="16" width="5" height="5" rx="1" />
							<rect x="9.5" y="16" width="5" height="5" rx="1" opacity="0.35" />
							<rect x="16" y="16" width="5" height="5" rx="1" opacity="0.7" />
						</svg>
					</button>
					<!-- Wax | Reagent: which wizard this robot's panel shows. Locked to the
					     running process while a run is in progress. -->
					<div
						class="flex shrink-0 overflow-hidden rounded border border-[var(--color-tron-border)] text-[11px] font-medium"
						role="group"
						aria-label="Process for {panel.robotName}"
						title={panel.forced ? `${label(panel.process)} run in progress — finish or cancel it to switch` : 'Choose which fill to run on this robot'}
					>
						{#each PROCESSES as p (p)}
							{@const current = panel.process === p}
							{#if current}
								<span class="bg-[var(--color-tron-cyan)] px-2.5 py-1 text-black" aria-current="true">{label(p)}</span>
							{:else if panel.forced}
								<span class="cursor-not-allowed px-2.5 py-1 text-[var(--color-tron-text-secondary)] opacity-50">{label(p)}</span>
							{:else}
								<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- URL built from the current page -->
								<a
									href={panelsHref(openMap, panel.robotId, p, false)}
									class="px-2.5 py-1 text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-cyan)]/15 hover:text-[var(--color-tron-cyan)]"
								>
									{label(p)}
								</a>
							{/if}
						{/each}
					</div>
					</div>
				</header>
				{#if hm.open}
					<div class="mb-3 rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-bg)]/40 p-3">
						<div class="mb-2 flex items-center justify-between gap-2">
							<h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-cyan)]">
								Reagent fill mistakes · last {HEATMAP_DAYS} days
								{#if hm.data}
									<span class="font-normal normal-case tracking-normal text-[var(--color-tron-text-secondary)]">
										— {hm.data.runs.length} of {hm.data.totalRuns} runs had an issue
									</span>
								{/if}
							</h3>
							<div class="flex shrink-0 items-center gap-1 text-[11px]">
								<button type="button" onclick={() => loadHeatmap(panel.robotId)} disabled={hm.loading} class="rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)] disabled:opacity-50">
									{hm.loading ? 'Loading…' : 'Refresh'}
								</button>
								<a href="{resolve('/manufacturing/cart-mfg/reagent-filling/well-issues')}?robot={encodeURIComponent(panel.robotId)}" class="rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]" title="All robots, other windows">
									Full page
								</a>
								<button type="button" onclick={() => toggleHeatmap(panel.robotId)} class="rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]" aria-label="Close heatmap">
									Close
								</button>
							</div>
						</div>
						{#if hm.error}
							<p class="text-xs text-red-300">Could not load the heatmap: {hm.error}</p>
						{:else if hm.data}
							<ReagentWellHeatmap groups={hm.data.groups} runs={hm.data.runs} compact />
						{:else}
							<p class="text-xs text-[var(--color-tron-text-secondary)]">Loading…</p>
						{/if}
					</div>
				{/if}
				{#if panel.process === 'wax'}
					<WaxWizard data={panel.data} />
				{:else}
					<ReagentWizard data={panel.data} />
				{/if}
			</section>
		{/each}
	</div>
{/if}
