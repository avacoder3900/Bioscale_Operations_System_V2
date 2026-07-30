<script lang="ts">
	interface PerProjectRow {
		id: string;
		name: string;
		color: string;
		active: number;
		doneInRange: number;
		medianCycleDays: number | null;
		wip: number;
		aging: number;
	}

	interface Props {
		rows: PerProjectRow[];
	}

	let { rows }: Props = $props();

	type SortKey = 'name' | 'active' | 'doneInRange' | 'medianCycleDays' | 'wip' | 'aging';
	let sortKey = $state<SortKey>('doneInRange');
	let sortDir = $state<'asc' | 'desc'>('desc');

	let sorted = $derived.by(() => {
		const dir = sortDir === 'asc' ? 1 : -1;
		return [...rows].sort((a, b) => {
			const av: any = a[sortKey] ?? -1;
			const bv: any = b[sortKey] ?? -1;
			if (typeof av === 'string') return av.localeCompare(bv) * dir;
			return ((av as number) - (bv as number)) * dir;
		});
	});

	function setSort(k: SortKey) {
		if (sortKey === k) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		else {
			sortKey = k;
			sortDir = 'desc';
		}
	}
	function arrow(k: SortKey) {
		return sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
	}
</script>

<div class="tron-card p-4">
	<h3 class="tron-text-primary mb-3 text-sm font-bold">Per project</h3>
	{#if rows.length === 0}
		<p class="tron-text-muted text-xs">No projects.</p>
	{:else}
		<table class="w-full text-xs">
			<thead>
				<tr class="tron-text-muted text-left">
					<th class="cursor-pointer pb-2" onclick={() => setSort('name')}>Project{arrow('name')}</th>
					<th class="cursor-pointer pb-2 text-right" onclick={() => setSort('active')}>Active{arrow('active')}</th>
					<th class="cursor-pointer pb-2 text-right" onclick={() => setSort('doneInRange')}>Done{arrow('doneInRange')}</th>
					<th class="cursor-pointer pb-2 text-right" onclick={() => setSort('medianCycleDays')}>Median cyc{arrow('medianCycleDays')}</th>
					<th class="cursor-pointer pb-2 text-right" onclick={() => setSort('wip')}>WIP{arrow('wip')}</th>
					<th class="cursor-pointer pb-2 text-right" onclick={() => setSort('aging')}>Aging{arrow('aging')}</th>
				</tr>
			</thead>
			<tbody>
				{#each sorted as r (r.id)}
					<tr class="border-t border-[var(--color-tron-border)]/40">
						<td class="py-1.5">
							<a
								href="/kanban/inventory"
								class="inline-flex items-center gap-2 hover:underline"
								style="color: {r.color};"
							>
								<span class="h-2 w-2 rounded-full" style="background: {r.color};"></span>
								{r.name}
							</a>
						</td>
						<td class="py-1.5 text-right">{r.active}</td>
						<td class="py-1.5 text-right">{r.doneInRange}</td>
						<td class="py-1.5 text-right">{r.medianCycleDays === null ? '—' : `${Math.round(r.medianCycleDays * 10) / 10}d`}</td>
						<td class="py-1.5 text-right">{r.wip}</td>
						<td class="py-1.5 text-right">{r.aging}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>
