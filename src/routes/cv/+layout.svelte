<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	const navItems = [
		{ href: '/cv', label: 'Dashboard', exact: true },
		{ href: '/cv/inspect', label: 'Capture', exact: false },
		{ href: '/cv/history', label: 'History', exact: false }
	];

	function isActive(item: (typeof navItems)[0], currentPath: string): boolean {
		if (item.exact) return currentPath === item.href;
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
				<svg class="h-7 w-7 text-[var(--color-tron-cyan)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
					<path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
				</svg>
			</div>
			<span class="text-[10px] font-bold tracking-wider text-[var(--color-tron-cyan)]">CV</span>
		</div>

		<!-- Nav items -->
		{#each navItems as item (item.href)}
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
		{/each}

		<!-- Back to BIMS link at bottom -->
		<div class="mt-auto mb-6">
			<a
				href="/spu"
				class="flex flex-col items-center gap-1 px-2 py-3 text-[11px] font-medium text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text)]"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
				</svg>
				BIMS
			</a>
		</div>
	</nav>

	<!-- Main content -->
	<main class="flex-1 overflow-auto p-6">
		{@render children()}
	</main>
</div>
