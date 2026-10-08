<!--
  Reagent fill-mistake heatmap (2026-10-06; a component since 2026-10-08).
  One section per robot + deck: the 24-position × 4-well grid coloured by how
  often each well was logged on the run-page tracker, carrier and per-well
  totals, the issue legend, and the runs that had issues. Rendered by the
  well-issues page (all robots, with filters) and inline on a Robots-page
  panel (one robot).
-->
<script lang="ts">
	import {
		REAGENT_DECK_ROWS,
		REAGENT_WELLS,
		REAGENT_WELL_ISSUE_DEFS,
		issueLabel,
		issueShort
	} from '$lib/manufacturing/reagent-well-issues';
	import type { HeatCell, HeatmapGroup, HeatmapRun } from '$lib/server/manufacturing/reagent-well-heatmap';

	interface Props {
		groups: HeatmapGroup[];
		runs: HeatmapRun[];
		/** Tighter paddings for the inline card on a robot panel. */
		compact?: boolean;
	}

	let { groups, runs, compact = false }: Props = $props();

	const fmt = (iso: string | null) =>
		iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

	/** 0 → neutral, else red ramp scaled to the group's hottest cell. */
	function heat(count: number, max: number): string {
		if (!count) return 'border-[var(--color-tron-border)]/50 bg-transparent text-[var(--color-tron-text-secondary)]/50';
		const t = Math.min(1, count / Math.max(1, max));
		if (t < 0.34) return 'border-red-400/40 bg-red-500/20 text-red-100';
		if (t < 0.67) return 'border-red-400/60 bg-red-500/40 text-white';
		return 'border-red-300 bg-red-500/70 text-white';
	}

	function cellTitle(cell: HeatCell | undefined, pos: number, well: number) {
		if (!cell) return `#${pos} · well ${well} — clean`;
		const parts = Object.entries(cell.byIssue).map(([k, n]) => `${issueLabel(k)} ×${n}`);
		return `#${pos} · well ${well} — ${cell.count}: ${parts.join(', ')}`;
	}

	// Per-position totals (all four wells) and per-carrier totals, to spot
	// "carrier 3 again" at a glance.
	function positionTotal(g: HeatmapGroup, pos: number) {
		return REAGENT_WELLS.reduce((s, w) => s + (g.cells[`${pos}:${w.well}`]?.count ?? 0), 0);
	}
	function carrierTotal(g: HeatmapGroup, carrier: 0 | 1 | 2) {
		return REAGENT_DECK_ROWS.reduce((s, row) => s + positionTotal(g, row[carrier]), 0);
	}
	function wellTotal(g: HeatmapGroup, well: number) {
		let s = 0;
		for (let p = 1; p <= 24; p++) s += g.cells[`${p}:${well}`]?.count ?? 0;
		return s;
	}
	function maxCell(g: HeatmapGroup) {
		return Math.max(1, ...Object.values(g.cells).map((c) => c.count));
	}

	const pad = $derived(compact ? 'p-3' : 'p-4');
</script>

<div class="space-y-4">
	{#if groups.length === 0}
		<p class="rounded border border-[var(--color-tron-border)] {pad} text-sm text-[var(--color-tron-text-secondary)]">No reagent runs in this window.</p>
	{/if}

	{#each groups as g (g.robotId + g.deckId)}
		{@const max = maxCell(g)}
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] {pad}">
			<div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
				<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">
					{g.robotName} <span class="text-[var(--color-tron-text-secondary)]">· {g.deckId}</span>
				</h3>
				<div class="text-xs text-[var(--color-tron-text-secondary)]">
					{g.runs} run{g.runs === 1 ? '' : 's'} · {g.cartsFilled} carts ·
					<span class={g.issues ? 'text-red-200' : 'text-emerald-300'}>{g.issues} issue{g.issues === 1 ? '' : 's'}</span>
					{#if g.cartsFilled}
						· {((g.issues / (g.cartsFilled * 4)) * 100).toFixed(1)}% of wells
					{/if}
					{#if g.issues}
						· by type: {Object.entries(g.byIssue).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${issueLabel(k)} ${n}`).join(', ')}
					{/if}
				</div>
			</div>

			{#if g.issues === 0}
				<p class="text-xs text-emerald-300">Clean — nothing logged for this robot/deck in the window.</p>
			{:else}
				<div class="grid gap-4 {compact ? '' : 'lg:grid-cols-[auto_1fr]'}">
					<div class="overflow-x-auto">
						<div class="mb-1 grid grid-cols-3 gap-2 text-center text-[10px] uppercase tracking-wide text-[var(--color-tron-text-secondary)]">
							<span>Carrier 1 · {carrierTotal(g, 0)}</span><span>Carrier 2 · {carrierTotal(g, 1)}</span><span>Carrier 3 · {carrierTotal(g, 2)}</span>
						</div>
						<div class="grid grid-cols-3 gap-2">
							{#each REAGENT_DECK_ROWS as row, ri (ri)}
								{#each row as pos (pos)}
									{@const tot = positionTotal(g, pos)}
									<div class="rounded border px-1.5 py-1 {tot ? 'border-red-400/50 bg-red-900/10' : 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]/40'}">
										<div class="flex items-center justify-between text-[10px] leading-tight">
											<span class="font-semibold text-[var(--color-tron-text)]">#{pos}</span>
											{#if tot}<span class="text-red-200">{tot}</span>{/if}
										</div>
										<div class="mt-1 grid grid-cols-4 gap-0.5">
											{#each REAGENT_WELLS as w (w.well)}
												{@const cell = g.cells[`${pos}:${w.well}`]}
												<div
													class="flex min-h-[26px] items-center justify-center rounded border font-mono text-[11px] leading-none {heat(cell?.count ?? 0, max)}"
													title={cellTitle(cell, pos, w.well)}
												>
													{cell ? cell.count : w.well}
												</div>
											{/each}
										</div>
									</div>
								{/each}
							{/each}
						</div>
					</div>
					<div class="text-xs">
						<div class="mb-2 text-[11px] uppercase tracking-wide text-[var(--color-tron-text-secondary)]">By well (all positions)</div>
						<ul class="space-y-1">
							{#each REAGENT_WELLS as w (w.well)}
								{@const n = wellTotal(g, w.well)}
								<li class="flex items-center gap-2">
									<span class="w-28 text-[var(--color-tron-text-secondary)]">Well {w.well} · {w.defaultName}</span>
									<span class="h-2 rounded bg-red-500/60" style="width: {g.issues ? Math.round((n / g.issues) * 160) : 0}px"></span>
									<span class={n ? 'text-red-200' : 'text-[var(--color-tron-text-secondary)]'}>{n}</span>
								</li>
							{/each}
						</ul>
						<div class="mt-4 mb-2 text-[11px] uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Legend</div>
						<div class="flex flex-wrap gap-1">
							{#each REAGENT_WELL_ISSUE_DEFS as d (d.code)}
								<span class="rounded border border-[var(--color-tron-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]" title={d.hint}>{issueShort(d.code)} = {d.label}</span>
							{/each}
						</div>
					</div>
				</div>
			{/if}
		</section>
	{/each}

	{#if runs.length}
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] {pad}">
			<h3 class="mb-2 text-sm font-semibold text-[var(--color-tron-text)]">Runs with logged issues</h3>
			<div class="space-y-2">
				{#each runs as r (r.id)}
					<details class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]/40">
						<summary class="cursor-pointer px-3 py-2 text-xs">
							<span class="font-semibold text-[var(--color-tron-text)]">{fmt(r.startedAt)}</span>
							<span class="text-[var(--color-tron-text-secondary)]"> · {r.robotName} · {r.deckId} · {r.assay ?? '—'} · {r.cartridgeCount} carts · {r.operator ?? ''}</span>
							<span class="ml-2 text-red-200">{r.issues.length} issue{r.issues.length === 1 ? '' : 's'}</span>
							<span class="ml-2 font-mono text-[10px] text-[var(--color-tron-text-secondary)]">{r.id}</span>
						</summary>
						<ul class="divide-y divide-[var(--color-tron-border)] border-t border-[var(--color-tron-border)] text-xs">
							{#each r.issues as i, k (k)}
								<li class="px-3 py-1.5">
									<span class="font-semibold text-[var(--color-tron-text)]">#{i.deckPosition}</span>
									<span class="text-[var(--color-tron-text-secondary)]"> · well {i.well}{i.reagentName ? ` ${i.reagentName}` : ''} · </span>
									<span class="text-red-200">{issueLabel(i.issue)}</span>
									{#if i.note}<span class="text-[var(--color-tron-text-secondary)]"> — {i.note}</span>{/if}
									<span class="ml-1 text-[10px] text-[var(--color-tron-text-secondary)]">{fmt(i.loggedAt)}{i.loggedBy ? ` · ${i.loggedBy}` : ''}</span>
								</li>
							{/each}
						</ul>
					</details>
				{/each}
			</div>
		</section>
	{/if}
</div>
