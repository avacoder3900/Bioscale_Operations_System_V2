<!--
  /manufacturing/cart-mfg/robots — the Robots page, the live command view
  (ROBOT-OVERHAUL round 6, 2026-10-08; inline setup 2026-10-14). The board
  (every OT-2, health, restart/reset) is rendered by the (robots) layout above;
  below it, one panel per robot, side by side:
    running    → that robot's wizard in run mode (timer first, robot controller,
                 tip-swap and well-tracker dropdowns, finish controls)
    setting up → that robot's wizard in PANEL mode, right here: a run already
                 in Setup / Loading is always open; an idle robot's setup opens
                 with Start wax / Start reagent and is named in ?open= so a
                 refresh keeps it open ("Close" drops it while no run exists)
    idle       → Start wax / Start reagent (open the setup in this panel)
  Nothing leaves the page any more. The wax-filling / reagent-filling pages
  remain untouched as full-page fallbacks ("Full page" in the panel header).
  Each panel header also has the heatmap toggle (card above the wizard).
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { resolve } from '$app/paths';
	import WaxWizard from '$lib/components/manufacturing/wax-filling/WaxWizard.svelte';
	import ReagentWizard from '$lib/components/manufacturing/reagent-filling/ReagentWizard.svelte';
	import ReagentWellHeatmap from '$lib/components/manufacturing/reagent-filling/ReagentWellHeatmap.svelte';
	import { SETUP_PATH, withOpen, withoutOpen, type BoardProcess } from '$lib/manufacturing/robot-panels';
	import type { WellIssueHeatmap } from '$lib/server/manufacturing/reagent-well-heatmap';

	let { data } = $props();

	const count = $derived(data.panels.length);
	const gridClass = $derived(count >= 3 ? 'xl:grid-cols-3' : count === 2 ? 'xl:grid-cols-2' : '');
	const label = (p: BoardProcess) => (p === 'wax' ? 'Wax' : 'Reagent');
	// Plain paths (resolve() wants a literal route); SETUP_PATH holds both.
	const setupHref = (p: BoardProcess, robotId: string) => `${SETUP_PATH[p]}?robot=${encodeURIComponent(robotId)}`;

	// ── inline setup: Start wax / Start reagent open that robot's setup wizard
	//    IN its panel. The ?open= query names it (refresh-safe); the page load
	//    then returns the wizard data for it. Close drops the entry again. No
	//    page change — the other robots' panels stay exactly where they are.
	let opening = $state<{ robotId: string; process: BoardProcess } | null>(null);
	async function openSetup(robotId: string, process: BoardProcess) {
		if (opening) return;
		opening = { robotId, process };
		try {
			await goto(withOpen($page.url, robotId, process), { noScroll: true, keepFocus: true });
		} finally {
			opening = null;
		}
	}
	async function closeSetup(robotId: string) {
		const next = withoutOpen($page.url, robotId);
		if (next) await goto(next, { noScroll: true, keepFocus: true });
	}

	// ── inline heatmap card: the icon opens this robot's reagent fill-mistake
	//    heatmap ABOVE the wizard, fetched on first open. Per robot: closed |
	//    loading | loaded | error.
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

	const startBtn =
		'flex min-h-[44px] flex-1 items-center justify-center rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-semibold text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-wait disabled:opacity-60';
	const toolBtn =
		'rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]';
</script>

{#if count === 0}
	<p class="text-sm text-[var(--color-tron-text-secondary)]">No active robots — add one under Equipment.</p>
{:else}
	<div class="grid grid-cols-1 gap-4 {gridClass}">
		{#each data.panels as panel (panel.robotId)}
			{@const hm = heatmapOf(panel.robotId)}
			{@const inlineSetup = panel.kind === 'wax-setup' || panel.kind === 'reagent-setup'}
			<section
				id="panel-{panel.robotId}"
				class="min-w-0 scroll-mt-20 rounded-lg border bg-[var(--color-tron-surface)]/40 p-3 {panel.live
					? 'border-[var(--color-tron-cyan)]/50'
					: inlineSetup
						? 'border-amber-400/40'
						: 'border-[var(--color-tron-border)]'}"
				aria-label="{panel.robotName}{panel.process ? ` ${panel.process} filling` : ''}"
			>
				<header class="mb-3 flex items-center justify-between gap-2 border-b border-[var(--color-tron-border)] pb-2">
					<h2 class="truncate text-sm font-semibold text-[var(--color-tron-text)]">
						{panel.robotName}
						{#if panel.process}
							<span class="font-normal text-[var(--color-tron-text-secondary)]">
								— {label(panel.process)} filling{panel.live ? '' : ` · ${panel.stage ?? 'setup'}`}
							</span>
						{:else}
							<span class="font-normal text-[var(--color-tron-text-secondary)]">— idle</span>
						{/if}
					</h2>
					<div class="flex shrink-0 items-center gap-1 text-[11px]">
						{#if inlineSetup && panel.process}
							<!-- The old single-robot setup page is still there, one click away. -->
							<a href={setupHref(panel.process, panel.robotId)} class={toolBtn} title="Open this setup on its own page">Full page</a>
							{#if panel.stage === null}
								<button type="button" onclick={() => closeSetup(panel.robotId)} class={toolBtn} title="Close this setup — no run has been created yet, the robot stays idle">Close</button>
							{/if}
						{/if}
						<!-- This robot's reagent fill-mistake heatmap (the per-well tracker's
						     history) — opens as a card above the wizard, not a new page. -->
						<button
							type="button"
							onclick={() => toggleHeatmap(panel.robotId)}
							class="flex h-6 w-6 shrink-0 items-center justify-center rounded border transition-colors {hm.open
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
								<button type="button" onclick={() => loadHeatmap(panel.robotId)} disabled={hm.loading} class="{toolBtn} disabled:opacity-50">
									{hm.loading ? 'Loading…' : 'Refresh'}
								</button>
								<a href="{resolve('/manufacturing/cart-mfg/reagent-filling/well-issues')}?robot={encodeURIComponent(panel.robotId)}" class={toolBtn} title="All robots, other windows">
									Full page
								</a>
								<button type="button" onclick={() => toggleHeatmap(panel.robotId)} class={toolBtn} aria-label="Close heatmap">Close</button>
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

				{#if panel.kind === 'wax'}
					<WaxWizard data={panel.data} mode="run" />
				{:else if panel.kind === 'reagent'}
					<ReagentWizard data={panel.data} mode="run" />
				{:else if panel.kind === 'wax-setup'}
					<!-- Setup right here; the panel flips to run mode once the robot is running. -->
					<WaxWizard data={panel.data} mode="panel" />
				{:else if panel.kind === 'reagent-setup'}
					<ReagentWizard data={panel.data} mode="panel" />
				{:else if panel.kind === 'setup'}
					<!-- A run in setup whose process this user may not read: the link-only view. -->
					<div class="rounded-lg border border-amber-500/40 bg-amber-900/10 p-4 text-center">
						<p class="text-sm font-semibold text-amber-200">{label(panel.process)} setup in progress{panel.stage ? ` — ${panel.stage}` : ''}</p>
						<p class="mt-1 text-xs text-amber-200/80">The run has not started on the robot yet. Its setup needs {label(panel.process).toLowerCase()} filling access; this panel goes live once the robot is running.</p>
						<a href={setupHref(panel.process, panel.robotId)} class="mt-3 inline-flex min-h-[40px] items-center rounded-lg border border-amber-400/60 bg-amber-500/20 px-4 py-2 text-sm font-medium text-amber-100 transition-colors hover:bg-amber-500/30">
							Continue {label(panel.process).toLowerCase()} setup →
						</a>
					</div>
				{:else}
					<div class="space-y-2">
						<p class="text-xs text-[var(--color-tron-text-secondary)]">Robot idle. Start a fill — the setup opens right here in this panel.</p>
						<div class="flex gap-2">
							{#if data.may.wax}
								<button type="button" onclick={() => openSetup(panel.robotId, 'wax')} disabled={opening !== null} class={startBtn}>
									{opening?.robotId === panel.robotId && opening.process === 'wax' ? 'Opening…' : 'Start wax'}
								</button>
							{/if}
							{#if data.may.reagent}
								<button type="button" onclick={() => openSetup(panel.robotId, 'reagent')} disabled={opening !== null} class={startBtn}>
									{opening?.robotId === panel.robotId && opening.process === 'reagent' ? 'Opening…' : 'Start reagent'}
								</button>
							{/if}
						</div>
					</div>
				{/if}
			</section>
		{/each}
	</div>
{/if}
