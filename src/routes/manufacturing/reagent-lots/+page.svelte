<script lang="ts">
	import type { PageData } from './$types';

	interface Props { data: PageData }
	let { data }: Props = $props();

	const statusOptions = [
		{ value: 'all', label: 'All statuses' },
		{ value: 'in_progress', label: 'In progress' },
		{ value: 'finalized', label: 'Finalized' },
		{ value: 'voided', label: 'Voided' }
	];

	function fmtDate(d: string | Date | null | undefined): string {
		if (!d) return '—';
		return new Date(d).toLocaleString();
	}

	function statusClass(s: string): string {
		switch (s) {
			case 'in_progress': return 'bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]';
			case 'finalized': return 'bg-emerald-500/15 text-emerald-400';
			case 'voided': return 'bg-rose-500/15 text-rose-400';
			default: return 'bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)]';
		}
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div>
			<h1 class="text-xl font-semibold text-[var(--color-tron-text)]">Reagent Lots</h1>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				R&amp;D and cartridge-prep protocol runs. Out-of-range QC values are recorded and flagged but never block.
			</p>
		</div>
		<div class="flex gap-2">
			<a
				href="/manufacturing/reagent-lots/compare"
				class="rounded-md border border-[var(--color-tron-border)] px-3 py-1.5 text-sm text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface)] hover:text-[var(--color-tron-text)]"
			>
				Compare Lots
			</a>
			<a
				href="/manufacturing/reagent-lots/new"
				class="rounded-md bg-[var(--color-tron-cyan)]/20 px-3 py-1.5 text-sm font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30"
			>
				+ Start New Lot
			</a>
		</div>
	</div>

	<form method="GET" class="flex flex-wrap items-end gap-3 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-3">
		<div>
			<label class="block text-xs text-[var(--color-tron-text-secondary)]" for="status-filter">Status</label>
			<select id="status-filter" name="status" value={data.filters.status}
				class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]">
				{#each statusOptions as opt}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</select>
		</div>
		<div>
			<label class="block text-xs text-[var(--color-tron-text-secondary)]" for="template-filter">Protocol</label>
			<select id="template-filter" name="template" value={data.filters.template}
				class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]">
				<option value="all">All protocols</option>
				{#each data.templates as tpl}
					<option value={tpl.slug}>{tpl.name} (v{tpl.version})</option>
				{/each}
			</select>
		</div>
		<button type="submit"
			class="rounded-md bg-[var(--color-tron-cyan)]/20 px-3 py-1 text-sm text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30">
			Apply
		</button>
	</form>

	<div class="overflow-x-auto rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]">
		<table class="min-w-full text-sm">
			<thead class="bg-[var(--color-tron-surface)] text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">
				<tr>
					<th class="px-3 py-2 text-left">Lot Barcode</th>
					<th class="px-3 py-2 text-left">Protocol</th>
					<th class="px-3 py-2 text-left">Operator</th>
					<th class="px-3 py-2 text-left">Started</th>
					<th class="px-3 py-2 text-left">Status</th>
					<th class="px-3 py-2 text-right">Flags</th>
					<th class="px-3 py-2 text-right">Output</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-[var(--color-tron-border)] text-[var(--color-tron-text)]">
				{#each data.lots as lot}
					<tr class="hover:bg-[var(--color-tron-surface)]">
						<td class="px-3 py-2 font-mono">
							<a href="/manufacturing/reagent-lots/{lot._id}" class="text-[var(--color-tron-cyan)] hover:underline">
								{lot.lotBarcode}
							</a>
						</td>
						<td class="px-3 py-2">
							{lot.templateName}
							<span class="text-xs text-[var(--color-tron-text-secondary)]">v{lot.templateVersion}</span>
						</td>
						<td class="px-3 py-2">{lot.operator?.username ?? '—'}</td>
						<td class="px-3 py-2">{fmtDate(lot.startedAt)}</td>
						<td class="px-3 py-2">
							<span class="rounded px-2 py-0.5 text-xs {statusClass(lot.status)}">{lot.status}</span>
						</td>
						<td class="px-3 py-2 text-right">
							{#if lot.flags?.length}
								<span class="rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-400">
									{lot.flags.length} flag{lot.flags.length === 1 ? '' : 's'}
								</span>
							{:else}
								<span class="text-xs text-[var(--color-tron-text-secondary)]">—</span>
							{/if}
						</td>
						<td class="px-3 py-2 text-right text-xs text-[var(--color-tron-text-secondary)]">
							{#if lot.finalOutputs?.concentration}
								{lot.finalOutputs.concentration} {lot.finalOutputs.concentrationUnit ?? ''}
								{#if lot.finalOutputs?.volume}
									<br />{lot.finalOutputs.volume} {lot.finalOutputs.volumeUnit ?? ''}
								{/if}
							{:else}
								—
							{/if}
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan="7" class="px-3 py-8 text-center text-sm text-[var(--color-tron-text-secondary)]">
							No lots yet. <a href="/manufacturing/reagent-lots/new" class="text-[var(--color-tron-cyan)] hover:underline">Start your first one</a>.
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
