<script lang="ts">
	let { data } = $props();

	let filter = $state('');
	let tab = $state<'revisions' | 'pulls'>('revisions');

	const filtered = $derived(
		filter.trim()
			? data.revisions.filter((r: any) => {
					const q = filter.trim().toLowerCase();
					return (
						r.summary.toLowerCase().includes(q) ||
						(r.changedBy?.username ?? '').toLowerCase().includes(q) ||
						r.label.toLowerCase().includes(q) ||
						r.changeType.toLowerCase().includes(q)
					);
				})
			: data.revisions
	);

	function fmt(d: string | null | undefined) {
		if (!d) return '—';
		return new Date(d).toLocaleString();
	}
	function sectionName(loc: any) {
		if (!loc || loc.sectionNumber == null) return null;
		return loc.sectionNumber === 0 ? 'Setup' : `Sub-Assembly ${loc.sectionNumber}`;
	}
	const typeColors: Record<string, string> = {
		import: 'text-[var(--color-tron-cyan)] border-[var(--color-tron-cyan)]/40',
		step_add: 'text-green-300 border-green-500/40',
		step_delete: 'text-red-300 border-red-500/40',
		step_edit: 'text-amber-300 border-amber-500/40',
		step_move: 'text-purple-300 border-purple-500/40',
		image_add: 'text-green-300 border-green-500/40',
		image_remove: 'text-red-300 border-red-500/40',
		image_edit: 'text-amber-300 border-amber-500/40',
		material_add: 'text-green-300 border-green-500/40',
		material_remove: 'text-red-300 border-red-500/40',
		material_edit: 'text-amber-300 border-amber-500/40',
		section_rename: 'text-amber-300 border-amber-500/40',
		section_add: 'text-green-300 border-green-500/40',
		section_delete: 'text-red-300 border-red-500/40',
		section_move: 'text-purple-300 border-purple-500/40',
		front_matter_edit: 'text-amber-300 border-amber-500/40',
		metadata_edit: 'text-[var(--color-tron-text-secondary)] border-[var(--color-tron-border)]'
	};
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<a href="/spu/assembly-wi" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">← SPU Assembly WI</a>
			<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Revision History</h1>
			{#if data.wi}
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
					{data.wi.documentNumber} · currently <span class="font-semibold text-[var(--color-tron-text)]">v{data.wi.currentVersion}</span>
					· last change by {data.wi.lastChangedBy?.username ?? '—'} on {fmt(data.wi.lastChangedAt)}
				</p>
			{/if}
		</div>
		<div class="flex gap-2">
			<button class="rounded border px-3 py-1.5 text-sm {tab === 'revisions' ? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}" onclick={() => (tab = 'revisions')}>Revisions ({data.revisions.length})</button>
			<button class="rounded border px-3 py-1.5 text-sm {tab === 'pulls' ? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}" onclick={() => (tab = 'pulls')}>Material pulls ({data.pulls.length})</button>
		</div>
	</div>

	{#if !data.wi}
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-sm text-[var(--color-tron-text-secondary)]">No work instruction has been imported yet.</div>
	{:else if tab === 'revisions'}
		<input class="w-full max-w-md rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]" placeholder="Filter by text, user, version or type…" bind:value={filter} />
		<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)]">
			<table class="min-w-full text-sm">
				<thead class="bg-[var(--color-tron-surface)] text-left text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">
					<tr>
						<th class="px-3 py-2">Version</th>
						<th class="px-3 py-2">When</th>
						<th class="px-3 py-2">Who</th>
						<th class="px-3 py-2">Type</th>
						<th class="px-3 py-2">Where</th>
						<th class="px-3 py-2">Change</th>
					</tr>
				</thead>
				<tbody>
					{#each filtered as r (r._id)}
						<tr class="border-t border-[var(--color-tron-border)] align-top">
							<td class="px-3 py-2 font-mono font-semibold text-[var(--color-tron-cyan)]">{r.label}</td>
							<td class="px-3 py-2 whitespace-nowrap text-[var(--color-tron-text-secondary)]">{fmt(r.changedAt)}</td>
							<td class="px-3 py-2">{r.changedBy?.username ?? '—'}</td>
							<td class="px-3 py-2"><span class="rounded border px-1.5 py-0.5 text-[11px] {typeColors[r.changeType] ?? ''}">{r.changeType.replace('_', ' ')}</span></td>
							<td class="px-3 py-2 whitespace-nowrap text-[var(--color-tron-text-secondary)]">
								{#if sectionName(r.location)}
									{sectionName(r.location)}{#if r.location.stepNumber != null} · step {r.location.stepNumber}{/if}
								{:else}—{/if}
							</td>
							<td class="px-3 py-2">
								{r.summary}
								{#if r.before != null || r.after != null}
									<details class="mt-1">
										<summary class="cursor-pointer text-xs text-[var(--color-tron-text-secondary)]">before / after</summary>
										<div class="mt-1 grid gap-2 md:grid-cols-2">
											<pre class="max-h-64 overflow-auto rounded bg-[var(--color-tron-bg)] p-2 text-[11px] text-red-200/80">{r.before == null ? '—' : JSON.stringify(r.before, null, 2)}</pre>
											<pre class="max-h-64 overflow-auto rounded bg-[var(--color-tron-bg)] p-2 text-[11px] text-green-200/80">{r.after == null ? '—' : JSON.stringify(r.after, null, 2)}</pre>
										</div>
									</details>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)]">
			<table class="min-w-full text-sm">
				<thead class="bg-[var(--color-tron-surface)] text-left text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">
					<tr>
						<th class="px-3 py-2">When</th>
						<th class="px-3 py-2">Who</th>
						<th class="px-3 py-2">Where</th>
						<th class="px-3 py-2">Part</th>
						<th class="px-3 py-2 text-right">Qty</th>
						<th class="px-3 py-2 text-right">Stock</th>
						<th class="px-3 py-2">SPU</th>
						<th class="px-3 py-2">Notes</th>
					</tr>
				</thead>
				<tbody>
					{#each data.pulls as p (p._id)}
						<tr class="border-t border-[var(--color-tron-border)]">
							<td class="px-3 py-2 whitespace-nowrap text-[var(--color-tron-text-secondary)]">{fmt(p.performedAt)}</td>
							<td class="px-3 py-2">{p.performedBy?.username ?? '—'}</td>
							<td class="px-3 py-2 whitespace-nowrap">{p.sectionNumber === 0 ? 'Setup' : `Sub-Assembly ${p.sectionNumber}`} · step {p.stepNumber} <span class="text-[var(--color-tron-text-secondary)]">(v{p.wiVersion})</span></td>
							<td class="px-3 py-2"><span class="font-mono text-xs text-[var(--color-tron-cyan)]">{p.partNumber ?? '—'}</span> {p.name}</td>
							<td class="px-3 py-2 text-right font-semibold text-red-300">−{p.quantity} {p.unit}</td>
							<td class="px-3 py-2 text-right text-[var(--color-tron-text-secondary)]">{p.previousQuantity ?? '?'} → {p.newQuantity ?? '?'}</td>
							<td class="px-3 py-2 font-mono text-xs">{p.deviceSerial ?? '—'}</td>
							<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{p.notes || ''}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
