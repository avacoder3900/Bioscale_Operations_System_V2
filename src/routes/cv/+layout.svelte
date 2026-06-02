<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';
	import { enhance } from '$app/forms';
	import GridBackground from '$lib/components/ui/GridBackground.svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
	let loggingOut = $state(false);
	let menuOpen = $state(false);

	const navItems = [
		{
			href: '/cv',
			label: 'CV Dashboard',
			icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z'
		},
		{
			href: '/capture',
			label: 'Capture',
			icon: 'M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z M15 13a3 3 0 11-6 0 3 3 0 016 0z'
		},
		{
			href: '/cv/stations',
			label: 'Capture Stations',
			icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01'
		},
		{
			href: '/cv/stream',
			label: 'Image Stream',
			icon: 'M4 6h16M4 12h16M4 18h7'
		},
		{
			href: '/cv/label',
			label: 'Label',
			icon: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z'
		},
		{
			href: '/cv/projects',
			label: 'Projects',
			icon: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z'
		},
		{
			href: '/',
			label: 'Back to BIMS',
			icon: 'M11 17l-5-5m0 0l5-5m-5 5h12'
		}
	];

	const activeLabel = $derived.by(() => {
		const current = $page.url.pathname;
		for (const item of navItems) {
			if (item.href === '/cv') {
				if (current === '/cv') return item.label;
			} else if (current.startsWith(item.href)) {
				return item.label;
			}
		}
		if (current.startsWith('/cv/cartridge')) return 'Cartridge Timeline';
		return 'Computer Vision';
	});

	function isActive(href: string, currentPath: string): boolean {
		if (href === '/cv') return currentPath === '/cv';
		if (href === '/') return false;
		return currentPath.startsWith(href);
	}

	function closeMenu() {
		menuOpen = false;
	}
</script>

<GridBackground>
	<div class="min-h-screen">
		<!-- Header -->
		<header class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
			<div class="mx-auto px-4 sm:px-6 lg:px-8">
				<div class="flex h-14 items-center justify-between">
					<a href="/cv" class="flex shrink-0 items-center gap-2">
						<div
							class="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-tron-cyan)]"
						>
							<svg
								class="h-5 w-5 text-[var(--color-tron-bg-primary)]"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
								/>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
								/>
							</svg>
						</div>
						<div>
							<h1 class="tron-text-primary tron-heading text-xl font-bold">Computer Vision</h1>
						</div>
					</a>

					<div class="flex items-center gap-2">
						<!-- Navigation Dropdown -->
						<div class="relative">
							<button
								type="button"
								class="flex min-h-[var(--size-touch-target)] items-center gap-2 rounded-lg px-4 py-2 font-medium transition-all duration-200
									text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-bg-tertiary)]"
								onclick={() => (menuOpen = !menuOpen)}
							>
								<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
								</svg>
								<span>{activeLabel}</span>
								<svg class="h-4 w-4 transition-transform {menuOpen ? 'rotate-180' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
								</svg>
							</button>

							{#if menuOpen}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<div class="fixed inset-0 z-40" onclick={closeMenu}></div>

								<div
									class="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] shadow-lg shadow-black/50"
								>
									{#each navItems as item (item.href)}
										{@const active = isActive(item.href, $page.url.pathname)}
										<a
											href={item.href}
											class="flex min-h-[var(--size-touch-target)] items-center gap-3 px-4 py-2 transition-all duration-150
												{active
												? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
												: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-cyan)]'}"
											onclick={closeMenu}
										>
											<svg class="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={item.icon} />
											</svg>
											<span class="font-medium">{item.label}</span>
										</a>
									{/each}
								</div>
							{/if}
						</div>

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
								class="rounded px-2 py-1.5 text-xs font-medium text-[var(--color-tron-text-secondary)] transition-colors
									hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-red)]
									disabled:opacity-50"
							>
								{loggingOut ? '...' : 'Logout'}
							</button>
						</form>
					</div>
				</div>
			</div>
		</header>

		<!-- Main Content -->
		<main class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
			{@render children()}
		</main>
	</div>
</GridBackground>
