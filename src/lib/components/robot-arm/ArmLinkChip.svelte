<script lang="ts">
	/**
	 * The arm Pi's link to the OT-2 (2026-11-06), on the robot bar of the Run tab
	 * and Stage Calibration: "Cable 58.0 ms" / "Wi-Fi 63.0 ms" when robot calls
	 * go through the arm Pi, "Queue" when they go through the Mongo queue (the
	 * reason on hover). Data from armLinkFor() in $lib/server/ot2-arm-link.
	 */
	import type { ArmLinkView } from '$lib/server/ot2-arm-link';

	let { link }: { link: ArmLinkView | null } = $props();

	const active = $derived(link?.status?.active ?? null);
	const rtt = $derived(active ? (link?.status?.[active]?.rtt_ms ?? null) : null);
</script>

{#if link}
	<span
		class="rounded border px-1.5 py-0.5 text-[10px] font-semibold"
		style={link.usable ? 'border-color: var(--color-tron-cyan); color: var(--color-tron-cyan)' : 'border-color: var(--color-tron-border); color: var(--color-tron-text-secondary)'}
		title={link.usable ? `Arm Pi → OT-2 over the ${active === 'cable' ? 'USB cable' : 'office Wi-Fi'}` : (link.reason ?? '')}
	>
		{#if link.usable}
			{active === 'cable' ? 'Cable' : 'Wi-Fi'} {rtt != null ? `${rtt.toFixed(1)} ms` : ''}
		{:else}
			Queue
		{/if}
	</span>
{/if}
