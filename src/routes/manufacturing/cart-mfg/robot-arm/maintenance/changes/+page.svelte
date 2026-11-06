<script lang="ts">
	/**
	 * Maintenance → Change Log (2026-11-06): every change to the arm, its Pi
	 * and its settings, newest first (labels in $lib/robot-arm/change-labels).
	 */
	import { labelTitle } from '$lib/robot-arm/change-labels';

	let { data } = $props();

	function when(iso: string): string {
		const d = new Date(iso);
		return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}
</script>

<div class="mx-auto max-w-5xl space-y-4 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-base font-semibold" style="color: var(--color-tron-cyan)">Change Log</h1>
		<a
			href="/manufacturing/cart-mfg/robot-arm/maintenance"
			class="text-xs transition-colors hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text-secondary)"
		>
			← Maintenance
		</a>
	</div>

	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
		{#if data.changesError}
			<p class="text-xs text-red-300">{data.changesError}</p>
		{:else if !data.changes.length}
			<p class="text-xs" style="color: var(--color-tron-text-secondary)">No Changes Logged</p>
		{:else}
			<table class="w-full text-left text-xs">
				<thead style="color: var(--color-tron-text-secondary)">
					<tr><th class="py-1 pr-3">When</th><th class="pr-3">Page</th><th class="pr-3">Hardware</th><th class="pr-3">Change</th><th class="pr-3">Source</th><th class="pr-3">By</th></tr>
				</thead>
				<tbody>
					{#each data.changes as c (c._id)}
						<tr class="border-t border-[var(--color-tron-border)]" style="color: var(--color-tron-text)">
							<td class="whitespace-nowrap py-1 pr-3" style="color: var(--color-tron-text-secondary)">{when(c.at)}</td>
							<td class="whitespace-nowrap pr-3">{labelTitle(c.page)}</td>
							<td class="whitespace-nowrap pr-3">{labelTitle(c.hardware)}</td>
							<td class="pr-3">
								<span class="font-mono">{c.line}</span>
								{#if c.note}<span class="ml-2" style="color: var(--color-tron-text-secondary)">{c.note}</span>{/if}
							</td>
							<td class="whitespace-nowrap pr-3">{labelTitle(c.source)}</td>
							<td class="whitespace-nowrap pr-3">{c.changedBy?.username ?? ''}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
</div>
