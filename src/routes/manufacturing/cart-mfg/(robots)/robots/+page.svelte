<!--
  /manufacturing/cart-mfg/robots — the Robots page (ROBOT-OVERHAUL round 2).
  The board (every OT-2, wax + reagent, health, restart/reset) is rendered by
  the (robots) layout above; this page renders the OPEN wizards side by side,
  one panel per robot. Robots with a run in progress are always open; Start on
  the board opens an idle one; Close hides an idle one again.
-->
<script lang="ts">
	import { page } from '$app/stores';
	import WaxWizard from '$lib/components/manufacturing/wax-filling/WaxWizard.svelte';
	import ReagentWizard from '$lib/components/manufacturing/reagent-filling/ReagentWizard.svelte';
	import { parseOpenPanels, panelsHref } from '$lib/manufacturing/robot-panels';

	let { data } = $props();

	const openMap = $derived(parseOpenPanels($page.url.searchParams.get('open')));
	const count = $derived(data.panels.length);
	const gridClass = $derived(count >= 3 ? 'xl:grid-cols-3' : count === 2 ? 'xl:grid-cols-2' : '');
</script>

{#if count === 0}
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		No wizard is open. On a robot above, <span class="text-[var(--color-tron-text)]">Start →</span> opens
		its wax or reagent fill here; robots with a run in progress open on their own.
	</p>
{:else}
	<div class="grid grid-cols-1 gap-4 {gridClass}">
		{#each data.panels as panel (panel.robotId + ':' + panel.process)}
			<section
				id="panel-{panel.robotId}"
				class="min-w-0 scroll-mt-20 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]/40 p-3"
				aria-label="{panel.robotName} {panel.process} filling"
			>
				<header class="mb-3 flex items-center justify-between gap-2 border-b border-[var(--color-tron-border)] pb-2">
					<h2 class="truncate text-sm font-semibold text-[var(--color-tron-text)]">
						{panel.robotName}
						<span class="font-normal text-[var(--color-tron-text-secondary)]">
							— {panel.process === 'wax' ? 'Wax' : 'Reagent'} filling
						</span>
					</h2>
					{#if !panel.forced}
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- URL built from the current page -->
						<a
							href={panelsHref(openMap, panel.robotId, null)}
							class="shrink-0 rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[11px] text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
							title="Hide this panel (no run has started)"
						>
							Close
						</a>
					{/if}
				</header>
				{#if panel.process === 'wax'}
					<WaxWizard data={panel.data} />
				{:else}
					<ReagentWizard data={panel.data} />
				{/if}
			</section>
		{/each}
	</div>
{/if}
