<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';

	interface Props {
		children: Snippet;
		data: { canManageUsers: boolean; canManageRoles: boolean };
	}

	let { children, data }: Props = $props();

	const tabs = $derived.by(() => {
		const items: { href: string; label: string }[] = [];
		if (data.canManageUsers) {
			items.push({ href: '/spu/admin/users', label: 'Users' });
			items.push({ href: '/spu/admin/invites', label: 'Invites' });
		}
		if (data.canManageRoles) {
			items.push({ href: '/spu/admin/roles', label: 'Roles' });
		}
		return items;
	});

	function isActive(href: string): boolean {
		return $page.url.pathname.startsWith(href);
	}
</script>

<div class="space-y-6">
	<div>
		<h2 class="text-lg font-semibold" style="color: var(--color-tron-cyan)">Administration</h2>
		<p class="text-sm" style="color: var(--color-tron-text-secondary)">
			Manage users, roles, and invitations
		</p>
	</div>

	<!-- Tab Navigation -->
	<div class="flex gap-1 border-b border-[var(--color-tron-border)]">
		{#each tabs as tab (tab.href)}
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			<a
				href={tab.href}
				class="px-4 py-2 text-sm font-medium transition-colors
					{isActive(tab.href)
					? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
					: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			>
				{tab.label}
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/each}
	</div>

	{@render children()}
</div>
