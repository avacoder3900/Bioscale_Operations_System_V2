<script lang="ts">
	import JsonTree from '$lib/components/JsonTree.svelte';

	interface Props {
		data: { barcode: string; cartridge: Record<string, unknown> };
	}
	let { data }: Props = $props();

	// Surface the run-result fields first (the "analyze" data), then the full
	// document — same idea as the research app's cartridge JSON view.
	const highlights = ['analysis', 'rawData', 'testResult', 'checkpoints'] as const;
	const present = $derived(highlights.filter((k) => data.cartridge[k] != null));
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-start justify-between gap-4">
		<div>
			<a href="/validation/optical-confirmation" class="text-sm text-[var(--color-tron-cyan)] hover:underline">
				← Back to Optical Confirmation
			</a>
			<h1 class="tron-heading mt-1 text-2xl font-bold">Cartridge Data</h1>
			<p class="tron-text-muted mt-1 font-mono text-sm">{data.barcode}</p>
		</div>
	</div>

	<!-- Run-result highlights (the analyze data), each expanded by default -->
	{#if present.length > 0}
		<div class="grid gap-4 md:grid-cols-2">
			{#each present as key (key)}
				<div class="tron-card p-4">
					<h2 class="tron-heading mb-2 text-sm font-semibold uppercase tracking-wide">{key}</h2>
					<div class="overflow-x-auto">
						<JsonTree value={data.cartridge[key]} defaultOpenDepth={2} />
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<div class="tron-card p-4 text-sm text-[var(--color-tron-text-secondary)]">
			No run/analysis data on this cartridge yet — it may not have been run. The full
			document is below.
		</div>
	{/if}

	<!-- Full document -->
	<div class="tron-card p-4">
		<h2 class="tron-heading mb-3 text-sm font-semibold uppercase tracking-wide">Full Document</h2>
		<div class="overflow-x-auto">
			<JsonTree value={data.cartridge} name={null} defaultOpenDepth={1} />
		</div>
	</div>
</div>
