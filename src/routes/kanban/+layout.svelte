<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';
	import { enhance } from '$app/forms';
	import GridBackground from '$lib/components/ui/GridBackground.svelte';

	interface Props {
		children: Snippet;
		data: {
			user: { id: string; username: string };
		};
	}

	let { children, data }: Props = $props();
	let loggingOut = $state(false);

	const navItems = [
		{
			href: '/kanban',
			label: 'Board',
			icon: 'M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7'
		},
		{
			href: '/kanban/list',
			label: 'List',
			icon: 'M4 6h16M4 10h16M4 14h16M4 18h16'
		},
		{
			href: '/kanban/projects',
			label: 'Projects',
			icon: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z'
		},
		{
			href: '/kanban/archived',
			label: 'Archive',
			icon: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4'
		}
	];

	function isActive(href: string, currentPath: string): boolean {
		if (href === '/kanban') return currentPath === '/kanban';
		return currentPath.startsWith(href);
	}
</script>

<GridBackground>
	<div class="min-h-screen">
		<!-- Header -->
		<header class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
			<div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
				<div class="flex h-16 items-center justify-between">
					<div class="flex items-center gap-3">
						<div
							class="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-tron-cyan)]"
						>
							<svg
								class="h-6 w-6 text-[var(--color-tron-bg-primary)]"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7"
								/>
							</svg>
						</div>
						<div>
							<h1 class="tron-text-primary tron-heading text-xl font-bold">Kanban Board</h1>
							<p class="tron-text-muted text-xs">Task Management</p>
						</div>
					</div>
					<nav class="flex items-center gap-1">
						{#each navItems as item}
							{@const active = isActive(item.href, $page.url.pathname)}
							<a
								href={item.href}
								class="flex min-h-[var(--size-touch-target)] items-center gap-2 rounded-lg px-4 py-2 transition-all duration-200
									{active
									? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
									: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-cyan)]'}"
							>
								<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d={item.icon}
									/>
								</svg>
								<span class="font-medium">{item.label}</span>
							</a>
						{/each}

							<!-- Back to Main Site -->
						<a
							href='/'"
							class="flex min-h-[var(--size-touch-target)] items-center gap-2 rounded-lg px-3 py-2 text-[var(--color-tron-text-secondary)] transition-all duration-200 hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-cyan)]"
							title="Back to Main Site"
						>
							<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1"
								/>
							</svg>
							<span class="font-medium">Main Site</span>
						</a>

						<!-- Logout -->
						<form
							method="POST"
							action="/logout"
							use:enhance={() => {
								loggingOut = true;
								return async ({ update }) => {
									await update();
									loggingOut = false;
								};
							}}
						>
							<button
								type="submit"
								disabled={loggingOut}
								class="flex min-h-[var(--size-touch-target)] items-center gap-2 rounded-lg px-4 py-2 text-[var(--color-tron-text-secondary)] transition-all
									duration-200 hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-red)]
									disabled:opacity-50"
							>
								<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
									/>
								</svg>
								<span class="font-medium">{loggingOut ? 'Logging out...' : 'Logout'}</span>
							</button>
						</form>
					</nav>
				</div>
			</div>
		</header>

		<!-- Main Content -->
		<main class="mx-auto max-w-[90rem] px-4 py-8 sm:px-6 lg:px-8">
			{@render children()}
		</main>
	</div>
</GridBackground>
