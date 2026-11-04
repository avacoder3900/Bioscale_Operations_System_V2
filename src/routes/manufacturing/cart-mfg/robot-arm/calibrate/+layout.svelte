<script lang="ts">
	/**
	 * Calibrate: two sub-tabs. "Arm home" is the camera side (AprilTags, home
	 * check, Return to home, tag registry); "Stage" is the OT-2 side (the
	 * single-cart stage studio: scan position, cart location, dispense depth).
	 */
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';

	let { children }: { children: Snippet } = $props();

	const BASE = '/manufacturing/cart-mfg/robot-arm/calibrate';
	const subtabs = [
		{ href: `${BASE}/stage`, label: 'Stage (OT-2)', hint: 'Teach the single-cart stage on the OT-2 the arm feeds' },
		{ href: `${BASE}/arm`, label: 'Camera Check', hint: 'Camera markers: is the arm home, send it home, recalibrate' }
	];
	let currentPath = $derived($page.url.pathname);
</script>

<div class="space-y-3">
	<div class="flex flex-wrap items-center gap-2 text-sm">
		{#each subtabs as t (t.href)}
			{@const active = currentPath.startsWith(t.href)}
			<a
				href={t.href}
				title={t.hint}
				class="rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors
					{active
					? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]'
					: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}"
				aria-current={active ? 'page' : undefined}
			>
				{t.label}
			</a>
		{/each}
	</div>
	{@render children()}
</div>
