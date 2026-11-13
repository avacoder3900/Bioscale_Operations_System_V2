<!--
  Diluent filling SETUP for one robot (DILUENT-FILL-1). Reached from the Robots
  page's "Start diluent" button; the wizard hands the operator back to /robots
  once the robot is running.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import DiluentWizard from '$lib/components/manufacturing/diluent-filling/DiluentWizard.svelte';

	let { data } = $props();

	const robotName = $derived(data.robots.find((r: { robotId: string }) => r.robotId === data.robotId)?.name ?? 'Robot');
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h1 class="text-xl font-semibold text-[var(--color-tron-text)]">
			{robotName} <span class="font-normal text-[var(--color-tron-text-secondary)]">— diluent filling setup</span>
		</h1>
		<a href={resolve('/manufacturing/cart-mfg/robots')} class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]">
			← All robots
		</a>
	</div>
	<DiluentWizard {data} {robotName} mode="setup" />
</div>
