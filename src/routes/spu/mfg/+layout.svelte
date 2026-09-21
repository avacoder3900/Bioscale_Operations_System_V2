<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';
	import SpuMfgTabs from '$lib/components/spu/SpuMfgTabs.svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	// Servicing is its own thing — no assembly tab strip there.
	const showTabs = $derived(!$page.url.pathname.startsWith('/spu/mfg/servicing'));
</script>

<div class="space-y-6">
	{#if showTabs}
		<SpuMfgTabs />
	{/if}
	{@render children()}
</div>
