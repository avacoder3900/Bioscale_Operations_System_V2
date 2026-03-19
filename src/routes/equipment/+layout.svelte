<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	const navItems = [
		{ href: '/equipment/activity', label: 'Overview' },
		{ href: '/equipment/decks-trays', label: 'Decks & Trays' },
		{ href: '/equipment/fridges-ovens', label: 'Fridges & Ovens' },
		{ href: '/equipment/temperature-probes', label: 'Temperature Probes' },
		{ href: '/equipment/robots', label: 'Opentrons Robots' }
	];

	function isActive(href: string, currentPath: string): boolean {
		return currentPath.startsWith(href);
	}
</script>

<div class="space-y-6">
	<nav class="flex items-center gap-2 text-sm">
		<a
			href='/'"
			class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			SPU
		</a>
		<span class="text-[var(--color-tron-text-secondary)]">/</span>
		<span class="text-[var(--color-tron-text)]">Equipment</span>
	</nav>

	<div class="flex gap-4 border-b border-[var(--color-tron-border)]">
		{#each navItems as item}
			<a
				href={item.href}
				class="border-b-2 px-4 py-3 text-sm font-medium transition-colors {isActive(
					item.href,
					$page.url.pathname
				)
					? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
					: 'border-transparent text-[var(--color-tron-text-secondary)]'}"
			>
				{item.label}
			</a>
		{/each}
	</div>

	{@render children()}
</div>
