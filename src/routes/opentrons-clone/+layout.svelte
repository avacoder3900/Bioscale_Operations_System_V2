<script lang="ts">
	import { page } from '$app/stores';

	let { children } = $props();

	const tabs = [
		{ href: '/opentrons-clone', label: 'Robots' },
		{ href: '/opentrons-clone/protocols', label: 'Protocols' },
		{ href: '/opentrons-clone/runs', label: 'Runs' },
		{ href: '/opentrons-clone/labware', label: 'Labware' },
		{ href: '/opentrons-clone/settings', label: 'Settings' }
	];
</script>

<div class="min-h-screen bg-gray-50">
	<header class="bg-white border-b">
		<div class="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
			<h1 class="text-lg font-semibold">Opentrons Clone</h1>
			<span class="text-xs text-gray-500">In-BIMS clone of the Opentrons App</span>
		</div>
		<nav class="max-w-6xl mx-auto px-4 flex gap-4 text-sm border-t">
			{#each tabs as tab (tab.href)}
				{@const active = $page.url.pathname === tab.href || $page.url.pathname.startsWith(tab.href + '/')}
				<a
					href={tab.href}
					class="py-2 border-b-2 {active ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-600 hover:text-gray-900'}"
				>
					{tab.label}
				</a>
			{/each}
		</nav>
	</header>
	<main class="max-w-6xl mx-auto px-4 py-6">
		{@render children()}
	</main>
</div>
