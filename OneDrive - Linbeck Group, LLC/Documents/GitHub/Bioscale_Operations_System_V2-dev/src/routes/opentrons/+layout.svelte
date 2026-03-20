<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	const navItems = [
		{ href: '/opentrons', label: 'Protocols', exact: false, matchPrefix: '/opentrons/protocols' },
		{ href: '/opentrons/devices', label: 'Devices', exact: false },
		{ href: '/opentrons/labware', label: 'Labware', exact: false }
	];

	function isActive(item: (typeof navItems)[0], currentPath: string): boolean {
		if (item.href === '/opentrons') {
			// Protocols is active for /opentrons, /opentrons/protocols/*
			return (
				currentPath === '/opentrons' ||
				currentPath.startsWith('/opentrons/protocols') ||
				currentPath.startsWith('/opentrons/runs')
			);
		}
		return currentPath.startsWith(item.href);
	}
</script>

<div class="flex min-h-screen">
	<!-- Sidebar -->
	<nav
		class="flex w-[90px] flex-col items-center border-r border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] pt-6"
	>
		<!-- Logo area -->
		<div class="mb-8 flex flex-col items-center gap-1">
			<div
				class="flex h-12 w-12 items-center justify-center rounded-full border-2 border-[var(--color-tron-cyan)]"
			>
				<svg class="h-7 w-7 text-[var(--color-tron-cyan)]" viewBox="0 0 24 24" fill="currentColor">
					<path
						d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"
					/>
				</svg>
			</div>
			<span class="text-[10px] font-bold tracking-wider text-[var(--color-tron-cyan)]">OT-2</span>
		</div>

		<!-- Nav items -->
		{#each navItems as item (item.href)}
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			<a
				href={item.href}
				class="flex w-full flex-col items-center gap-1 px-2 py-3 text-[11px] font-medium transition-colors {isActive(
					item,
					$page.url.pathname
				)
					? 'bg-[var(--color-tron-bg)] text-[var(--color-tron-cyan)]'
					: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			>
				{item.label}
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/each}
	</nav>

	<!-- Main content -->
	<main class="flex-1 overflow-auto p-6">
		{@render children()}
	</main>
</div>
