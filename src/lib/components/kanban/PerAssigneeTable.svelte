<script lang="ts">
	interface PerAssigneeRow {
		id: string;
		username: string;
		active: number;
		doneInRange: number;
		loadScore: number;
		wip: number;
		aging: number;
	}

	interface Props {
		rows: PerAssigneeRow[];
	}

	let { rows }: Props = $props();

	type SortKey = 'username' | 'active' | 'doneInRange' | 'loadScore' | 'wip' | 'aging';
	let sortKey = $state<SortKey>('loadScore');
	let sortDir = $state<'asc' | 'desc'>('desc');

	let sorted = $derived.by(() => {
		const dir = sortDir === 'asc' ? 1 : -1;
		const result = [...rows].sort((a, b) => {
			if (a.id === '__unassigned__') return 1;
			if (b.id === '__unassigned__') return -1;
			const av: any = a[sortKey] ?? -1;
			const bv: any = b[sortKey] ?? -1;
			if (typeof av === 'string') return av.localeCompare(bv) * dir;
			return ((av as number) - (bv as number)) * dir;
		});
		return result;
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
	<h3 class="tron-text-primary mb-3 text-sm font-bold">Per assignee</h3>
	{#if rows.length === 0}
		<p class="tron-text-muted text-xs">No assignees.</p>
	{:else}
		<table class="w-full text-xs">
			<thead>
				<tr class="tron-text-muted text-left">
					<th class="cursor-pointer pb-2" onclick={() => setSort('username')}>Person{arrow('username')}</th>
					<th class="cursor-pointer pb-2 text-right" onclick={() => setSort('active')}>Active{arrow('active')}</th>
					<th class="cursor-pointer pb-2 text-right" onclick={() => setSort('doneInRange')}>Done{arrow('doneInRange')}</th>
					<th class="cursor-pointer pb-2 text-right" onclick={() => setSort('loadScore')} title="Weighted: short=1, medium=2, long=4">Load{arrow('loadScore')}</th>
					<th class="cursor-pointer pb-2 text-right" onclick={() => setSort('wip')}>WIP{arrow('wip')}</th>
					<th class="cursor-pointer pb-2 text-right" onclick={() => setSort('aging')}>Aging{arrow('aging')}</th>
				</tr>
			</thead>
			<tbody>
				{#each sorted as r (r.id)}
					<tr class="border-t border-[var(--color-tron-border)]/40">
						<td class="py-1.5">
							{#if r.id === '__unassigned__'}
								<span class="tron-text-muted">— Unassigned —</span>
							{:else}
								<a
									href="/kanban/list?assignee={r.id}"
									class="hover:underline"
									style="color: var(--color-tron-cyan);"
								>
									{r.username}
								</a>
							{/if}
						</td>
						<td class="py-1.5 text-right">{r.active}</td>
						<td class="py-1.5 text-right">{r.doneInRange}</td>
						<td class="py-1.5 text-right">{r.loadScore}</td>
						<td class="py-1.5 text-right">{r.wip}</td>
						<td class="py-1.5 text-right">{r.aging}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>
