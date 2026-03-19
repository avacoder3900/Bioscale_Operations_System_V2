<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';
	import { enhance } from '$app/forms';
	import GridBackground from '$lib/components/ui/GridBackground.svelte';

	interface Props {
		children: Snippet;
		data: {
			user: { id: string; username: string };
			permissions: {
				canRead: boolean;
				canWrite: boolean;
				canApprove: boolean;
				canTrain: boolean;
			};
		};
	}

	let { children, data }: Props = $props();
	let loggingOut = $state(false);
	let menuOpen = $state(false);

	const navItems = [
		{
			href: '/documents',
			label: 'All Documents',
			icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
			exact: true,
			requiresApprove: false
		},
		{
			href: '/documents/training',
			label: 'My Training',
			icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
			exact: false,
			requiresApprove: false
		},
		{
			href: '/documents/approvals',
			label: 'Pending Approvals',
			icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
			exact: false,
			requiresApprove: true
		}
	];

	const visibleNavItems = $derived(
		navItems.filter((item) => !item.requiresApprove || data.permissions.canApprove)
	);

	const activeLabel = $derived.by(() => {
		const current = $page.url.pathname;
		for (const item of visibleNavItems) {
			if (item.exact) {
				if (current === item.href) return item.label;
			} else if (current.startsWith(item.href)) {
				return item.label;
			}
		}
		return 'Documents';
	});

	function isActive(href: string, currentPath: string, exact: boolean): boolean {
		if (exact) return currentPath === href;
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
									d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
								/>
							</svg>
						</div>
						<div>
							<h1 class="tron-text-primary tron-heading text-xl font-bold">Document Control</h1>
						</div>
					</div>

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
								<!-- Backdrop -->
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<div class="fixed inset-0 z-40" onclick={closeMenu}></div>

								<!-- Dropdown -->
								<div
									class="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] shadow-lg shadow-black/50"
								>
									{#each visibleNavItems as item (item.href)}
										{@const active = isActive(item.href, $page.url.pathname, item.exact)}
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

									<!-- Divider + Back to SPU -->
									<div class="border-t border-[var(--color-tron-border)]">
										<a
											href='/'"
											class="flex min-h-[var(--size-touch-target)] items-center gap-3 px-4 py-2 text-[var(--color-tron-text-secondary)] transition-all duration-150
												hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-cyan)]"
											onclick={closeMenu}
										>
											<svg class="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 17l-5-5m0 0l5-5m-5 5h12" />
											</svg>
											<span class="font-medium">Back to Dashboard</span>
										</a>
									</div>
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
