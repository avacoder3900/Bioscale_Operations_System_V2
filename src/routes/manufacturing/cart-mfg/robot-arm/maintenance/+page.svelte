<script lang="ts">
	/**
	 * Maintenance — the tools the wax-fill line no longer needs day to day,
	 * kept one click away rather than as top-level tabs (2026-11 UI redesign),
	 * plus the Change Log: every change to the arm, its Pi and its settings
	 * (2026-11-06; labels in $lib/robot-arm/change-labels).
	 */
	import { labelTitle } from '$lib/robot-arm/change-labels';

	let { data } = $props();

	const BASE = '/manufacturing/cart-mfg/robot-arm/maintenance';
	const tools = [
		{
			href: `${BASE}/control`,
			title: 'Leader Arm & Recordings'
		},
		{
			href: `${BASE}/cleanup`,
			title: 'Clean-Up'
		},
		{
			href: `${BASE}/jog`,
			title: 'Jog'
		},
		{
			href: `${BASE}/sync-zero`,
			title: 'Sync Zero & Joint Map'
		},
		{
			href: `${BASE}/tests`,
			title: 'Tests'
		}
	];

	let logHidden = $state(false);

	function when(iso: string): string {
		const d = new Date(iso);
		return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}
</script>

<div class="space-y-3">
	<h2 class="text-base font-semibold" style="color: var(--color-tron-cyan)">Maintenance</h2>
	<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
		{#each tools as t (t.href)}
			<a
				href={t.href}
				class="block rounded-lg border p-4 transition-colors hover:border-[var(--color-tron-cyan)]"
				style="border-color: var(--color-tron-border); background: var(--color-tron-surface);"
			>
				<div class="text-sm font-semibold" style="color: var(--color-tron-cyan)">{t.title}</div>
			</a>
		{/each}
	</div>

	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
		<div class="flex items-center justify-between gap-2">
			<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Change Log</h3>
			<button
				type="button"
				onclick={() => (logHidden = !logHidden)}
				class="rounded border px-2 py-0.5 text-xs"
				style="border-color: var(--color-tron-cyan); color: var(--color-tron-cyan)"
				aria-expanded={!logHidden}
			>
				{logHidden ? 'Show' : 'Hide'}
			</button>
		</div>
		{#if !logHidden}
			{#if data.changesError}
				<p class="mt-2 text-xs text-red-300">{data.changesError}</p>
			{:else if !data.changes.length}
				<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">No Changes Logged</p>
			{:else}
				<table class="mt-2 w-full text-left text-xs">
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
		{/if}
	</section>
</div>
