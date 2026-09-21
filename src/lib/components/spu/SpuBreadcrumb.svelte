<script lang="ts">
	/**
	 * Breadcrumb for the SPU section (post-restructure IA):
	 * SPU → Inventory / Assembly (+ Barcodes) / Servicing / Validation.
	 * "SPU" always links to the inventory — the section's de-facto home.
	 */
	interface Crumb {
		label: string;
		href?: string;
	}
	interface Props {
		trail: Crumb[];
	}
	let { trail }: Props = $props();
</script>

<nav class="flex flex-wrap items-center gap-2 text-sm">
	<a
		href="/spu"
		class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
	>
		SPU
	</a>
	{#each trail as crumb, i (crumb.label)}
		<span class="text-[var(--color-tron-text-secondary)]">/</span>
		{#if crumb.href && i < trail.length - 1}
			<a
				href={crumb.href}
				class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
			>
				{crumb.label}
			</a>
		{:else}
			<span class="text-[var(--color-tron-cyan)]">{crumb.label}</span>
		{/if}
	{/each}
</nav>
