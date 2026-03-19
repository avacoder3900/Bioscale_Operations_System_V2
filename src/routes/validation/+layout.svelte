<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	const navItems = [
		{
			href: '/validation/magnetometer',
			label: 'Magnetometer',
			icon: 'M13 10V3L4 14h7v7l9-11h-7z'
		},
		{
			href: '/validation/spectrophotometer',
			label: 'Spectrophotometer',
			icon: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z'
		},
		{
			href: '/validation/thermocouple',
			label: 'Thermocouple',
			icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z'
		}
	];

	function isActive(href: string, currentPath: string, exact = false): boolean {
		if (exact) return currentPath === href;
		return currentPath.startsWith(href);
	}

	function getSectionName(path: string): string {
		if (path.includes('/spectrophotometer')) return 'Spectrophotometer';
		if (path.includes('/thermocouple')) return 'Thermocouple';
		if (path.includes('/magnetometer')) return 'Magnetometer';
		return 'Dashboard';
	}

	let currentSection = $derived(getSectionName($page.url.pathname));
</script>

<div class="space-y-6">
	<!-- Breadcrumb -->
	<nav class="flex items-center gap-2 text-sm">
		<a
			href='/'
			class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			SPU
		</a>
		<span class="text-[var(--color-tron-text-secondary)]">/</span>
		<a
			href="/validation"
			class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			Validation
		</a>
		{#if currentSection !== 'Dashboard'}
			<span class="text-[var(--color-tron-text-secondary)]">/</span>
			<span class="text-[var(--color-tron-cyan)]">{currentSection}</span>
		{/if}
	</nav>

	<!-- Sub-navigation tabs -->
	<div class="flex gap-2 border-b border-[var(--color-tron-border)] pb-4">
		{#each navItems as item (item.href)}
			{@const active = isActive(item.href, $page.url.pathname)}
			<a
				href={item.href}
				class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200
					{active
					? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
					: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-cyan)]'}"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d={item.icon}
					/>
				</svg>
				{item.label}
			</a>
		{/each}
	</div>

	<!-- Page content -->
	{@render children()}
</div>
