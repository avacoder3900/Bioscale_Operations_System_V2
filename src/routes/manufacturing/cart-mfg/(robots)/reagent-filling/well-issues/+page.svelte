<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import ReagentWellHeatmap from '$lib/components/manufacturing/reagent-filling/ReagentWellHeatmap.svelte';

	let { data } = $props();

	function setParam(k: string, v: string) {
		const url = new URL($page.url);
		if (v) url.searchParams.set(k, v); else url.searchParams.delete(k);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- URL built from current page
		goto(url.pathname + url.search, { invalidateAll: true });
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Reagent fill mistakes by position</h2>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">
				Everything logged on the run-page well tracker, last {data.days} days — {data.runs.length} of {data.totalRuns} runs had at least one issue.
				A hot spot that repeats on one position or one carrier is deck geometry; scattered single cells are the tip.
			</p>
		</div>
		<div class="flex items-center gap-2 text-xs">
			<label class="text-[var(--color-tron-text-secondary)]" for="wi-robot">Robot</label>
			<select id="wi-robot" class="tron-input !w-auto !py-1" value={data.robotFilter} onchange={(e) => setParam('robot', (e.currentTarget as HTMLSelectElement).value)}>
				<option value="">All</option>
				{#each data.robots as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
			</select>
			<label class="text-[var(--color-tron-text-secondary)]" for="wi-days">Window</label>
			<select id="wi-days" class="tron-input !w-auto !py-1" value={String(data.days)} onchange={(e) => setParam('days', (e.currentTarget as HTMLSelectElement).value)}>
				{#each [7, 14, 30, 60, 90, 180] as d (d)}<option value={String(d)}>{d} days</option>{/each}
			</select>
		</div>
	</div>

	<ReagentWellHeatmap groups={data.groups} runs={data.runs} />
</div>
