<!--
  Wax filling SETUP for one robot (ROBOT-OVERHAUL round 6, 2026-10-08). Reached
  from the Robots page's "Start wax" button; the wizard hands the operator
  back to /robots as soon as the robot is running.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import WaxWizard from '$lib/components/manufacturing/wax-filling/WaxWizard.svelte';

	let { data } = $props();
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h1 class="text-xl font-semibold text-[var(--color-tron-text)]">
			{data.robotName} <span class="font-normal text-[var(--color-tron-text-secondary)]">— wax filling setup</span>
		</h1>
		<a href={resolve('/manufacturing/cart-mfg/robots')} class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]">
			← All robots
		</a>
	</div>
	<WaxWizard {data} mode="setup" />
</div>
