<script lang="ts">
	import type { Snippet } from 'svelte';
	import SpuMfgTabs from '$lib/components/spu/SpuMfgTabs.svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
</script>

<div class="space-y-6">
	<SpuMfgTabs showBreadcrumb={false} />
	{@render children()}
</div>
