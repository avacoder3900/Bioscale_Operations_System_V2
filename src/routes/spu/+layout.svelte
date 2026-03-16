<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page, navigating } from '$app/stores';
	import { enhance } from '$app/forms';
	import GridBackground from '$lib/components/ui/GridBackground.svelte';

	interface Props {
		children: Snippet;
		data: {
			canAccessDocuments: boolean;
			canAccessInventory: boolean;
			canAccessCartridges: boolean;
			canAccessAssays: boolean;
			canAccessDevices: boolean;
			canAccessTestResults: boolean;
			canAccessAdmin: boolean;
			isBoxConnected: boolean;
			particleStatus: 'connected' | 'stale' | 'disconnected';
		};
	}

	let { children, data }: Props = $props();
	let loggingOut = $state(false);
	let menuOpen = $state(false);

	// Navigation timeout — if client-side routing is stuck for >10s, force a full page load
	$effect(() => {
		const nav = $navigating;
		if (nav) {
			const targetUrl = nav.to?.url.href ?? window.location.href;
			const timer = setTimeout(() => {
				window.location.href = targetUrl;
			}, 10000);
			return () => clearTimeout(timer);
		}
	});

	type NavItem = { href: string; label: string; icon: string };
	type NavGroup = { label: string; icon: string; items: NavItem[] };

	const topItems: NavItem[] = [
		{
			href: '/spu',
			label: 'Dashboard',
			icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6'
		},
		{
			href: '/kanban',
			label: 'Kanban',
			icon: 'M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7'
		},
		{
			href: '/cv',
			label: 'Computer Vision',
			icon: 'M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z'
		}
	];

	const navGroups: NavGroup[] = [
		{
			label: 'Manufacturing',
			icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35',
			items: [
				{ href: '/spu/manufacturing', label: 'Cartridge Mfg', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35' },
				{ href: '/spu/assembly', label: 'SPU Assembly', icon: 'M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z' },
				{ href: '/spu/documents/instructions', label: 'Work Instructions', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
				{ href: '/spu/validation', label: 'Validation', icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' }
			]
		},
		{
			label: 'Inventory & Supply',
			icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
			items: [
				{ href: '/spu/parts', label: 'Parts', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01' },
				{ href: '/spu/receiving', label: 'Receiving (ROG)', icon: 'M8 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-2m-4-1v8m0 0l3-3m-3 3L9 8' },
				{ href: '/spu/inventory/transactions', label: 'Transactions', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4' },
				{ href: '/spu/manufacturing/consumables', label: 'Consumables', icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10' },
				{ href: '/spu/bom/settings/mapping', label: 'BOM Mapping', icon: 'M4 6h16M4 10h16M4 14h16M4 18h16' },
				{ href: '/spu/shipping', label: 'Shipping', icon: 'M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0' }
			]
		},
		{
			label: 'Cartridges',
			icon: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z',
			items: [
				{ href: '/spu/cartridge-dashboard', label: 'Cart Dashboard', icon: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z' },
				{ href: '/spu/cartridges', label: 'Cartridge Registry', icon: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z' },
				{ href: '/spu/cartridge-admin', label: 'Cart Admin', icon: 'M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4' },
				{ href: '/spu/assays', label: 'Assays', icon: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z' }
			]
		},
		{
			label: 'Infrastructure',
			icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z',
			items: [
				{ href: '/spu/equipment/activity', label: 'Equipment', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35' },
				{ href: '/spu/devices', label: 'Devices', icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z' },
				{ href: '/spu/test-results', label: 'Test Results', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' }
			]
		},
		{
			label: 'Admin',
			icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35',
			items: [
				{ href: '/documents', label: 'Documents', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
				{ href: '/spu/customers', label: 'Customers', icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z' },
				{ href: '/spu/admin', label: 'User Manager', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35' }
			]
		}
	];

	const filteredGroups = $derived.by(() => {
		return navGroups.map(group => {
			const filtered = group.items.filter(item => {
				if (item.href === '/spu/inventory/transactions') return data.canAccessInventory;
				if (item.href === '/spu/cartridges') return data.canAccessCartridges;
				if (item.href === '/spu/assays') return data.canAccessAssays;
				if (item.href === '/spu/devices') return data.canAccessDevices;
				if (item.href === '/spu/test-results') return data.canAccessTestResults;
				if (item.href === '/documents') return data.canAccessDocuments;
				if (item.href === '/spu/admin') return data.canAccessAdmin;
				return true;
			});
			return { ...group, items: filtered };
		}).filter(group => group.items.length > 0);
	});

	let expandedGroups = $state(new Set<string>());

	$effect(() => {
		const current = $page.url.pathname;
		for (const group of filteredGroups) {
			for (const item of group.items) {
				const match = item.href === '/spu' ? current === '/spu' : current.startsWith(item.href);
				if (match) {
					expandedGroups.add(group.label);
					break;
				}
			}
		}
	});

	function toggleGroup(label: string) {
		if (expandedGroups.has(label)) {
			expandedGroups.delete(label);
		} else {
			expandedGroups.add(label);
		}
		expandedGroups = new Set(expandedGroups);
	}

	const allNavItems = $derived([
		...topItems,
		...filteredGroups.flatMap(g => g.items)
	]);

	const activeLabel = $derived.by(() => {
		const current = $page.url.pathname;
		for (const item of allNavItems) {
			if (item.href === '/spu') {
				if (current === '/spu') return item.label;
			} else if (current.startsWith(item.href)) {
				return item.label;
			}
		}
		return 'Navigate';
	});

	function isActive(href: string, currentPath: string): boolean {
		if (href === '/spu') return currentPath === '/spu';
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
					<a href="/spu" class="flex shrink-0 items-center gap-2">
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
									d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
								/>
							</svg>
						</div>
						<div>
							<h1 class="tron-text-primary tron-heading text-xl font-bold">Bioscale Internal Management System</h1>
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
								<!-- Backdrop -->
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<div class="fixed inset-0 z-40" onclick={closeMenu}></div>

								<!-- Dropdown -->
								<div
									class="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] shadow-lg shadow-black/50 max-h-[80vh] overflow-y-auto"
								>
									{#each topItems as item (item.href)}
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

									{#each filteredGroups as group (group.label)}
										<div class="border-t border-[var(--color-tron-border)]">
											<!-- svelte-ignore a11y_no_static_element_interactions -->
											<!-- svelte-ignore a11y_click_events_have_key_events -->
											<div
												class="flex min-h-[var(--size-touch-target)] cursor-pointer items-center gap-3 px-4 py-2 text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-cyan)] select-none"
												onclick={() => toggleGroup(group.label)}
											>
												<svg class="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={group.icon} />
												</svg>
												<span class="flex-1 font-semibold text-sm uppercase tracking-wider">{group.label}</span>
												<svg class="h-4 w-4 transition-transform {expandedGroups.has(group.label) ? 'rotate-180' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
												</svg>
											</div>

											{#if expandedGroups.has(group.label)}
												{#each group.items as item (item.href)}
													{@const active = isActive(item.href, $page.url.pathname)}
													<a
														href={item.href}
														class="flex min-h-[var(--size-touch-target)] items-center gap-3 pl-8 pr-4 py-2 transition-all duration-150
															{active
															? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
															: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-cyan)]'}"
														onclick={closeMenu}
													>
														<svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
															<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={item.icon} />
														</svg>
														<span class="text-sm">{item.label}</span>
													</a>
												{/each}
											{/if}
										</div>
									{/each}
								</div>
							{/if}
						</div>

						<!-- Particle Status -->
						<a
							href="/spu/particle/settings"
							class="flex min-h-[var(--size-touch-target)] items-center gap-2 rounded-lg px-3 py-2 text-[var(--color-tron-text-secondary)] transition-all duration-200 hover:bg-[var(--color-tron-bg-tertiary)]"
							title={data.particleStatus === 'connected'
								? 'Particle: Connected'
								: data.particleStatus === 'stale'
									? 'Particle: Sync Stale'
									: 'Particle: Not Connected'}
						>
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
								/>
							</svg>
							<div
								class="h-2 w-2 rounded-full {data.particleStatus === 'connected'
									? 'bg-[var(--color-tron-green)]'
									: data.particleStatus === 'stale'
										? 'bg-[var(--color-tron-yellow)]'
										: 'bg-[var(--color-tron-text-secondary)]'}"
							></div>
						</a>

						<!-- Box.com Status -->
						<a
							href="/spu/bom/settings"
							class="flex items-center gap-1.5 rounded px-2 py-1.5 text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
							title={data.isBoxConnected ? 'Box.com: Connected' : 'Box.com: Not Connected'}
						>
							<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
								/>
							</svg>
							<div
								class="h-1.5 w-1.5 rounded-full {data.isBoxConnected
									? 'bg-[var(--color-tron-green)]'
									: 'bg-[var(--color-tron-text-secondary)]'}"
							></div>
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
