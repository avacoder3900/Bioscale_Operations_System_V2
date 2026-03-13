<script lang="ts">
	import type { Snippet } from 'svelte';

	interface IpReference {
		label: string;
		url: string;
	}

	interface Props {
		revisionNumber: number;
		effectiveDate: Date;
		renderedHtmlUrl: string | null;
		references: IpReference[];
		partId: string;
		formPanel: Snippet;
	}

	let { revisionNumber, effectiveDate, renderedHtmlUrl, references, partId, formPanel }: Props =
		$props();

	let activeTab = $state<'document' | 'form'>('form');
	let docCollapsed = $state(false);
	let htmlContent = $state<string | null>(null);
	let htmlLoading = $state(false);
	let htmlError = $state<string | null>(null);

	const effectiveDateStr = $derived(
		effectiveDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
	);

	$effect(() => {
		if (!renderedHtmlUrl) return;
		htmlLoading = true;
		htmlError = null;
		fetch(renderedHtmlUrl)
			.then((r) => {
				if (!r.ok) throw new Error(`Failed to load document (${r.status})`);
				return r.text();
			})
			.then((text) => (htmlContent = text))
			.catch((err) => (htmlError = err instanceof Error ? err.message : 'Failed to load'))
			.finally(() => (htmlLoading = false));
	});
</script>

<!-- Mobile: tabbed interface (<768px) -->
<div class="block md:hidden">
	<div class="mb-3 flex border-b border-[var(--color-tron-border)]">
		<button
			type="button"
			class="px-4 py-2 text-sm font-medium {activeTab === 'document'
				? 'border-b-2 border-cyan-400 text-cyan-400'
				: 'tron-text-muted'}"
			onclick={() => (activeTab = 'document')}
		>
			Document
		</button>
		<button
			type="button"
			class="px-4 py-2 text-sm font-medium {activeTab === 'form'
				? 'border-b-2 border-cyan-400 text-cyan-400'
				: 'tron-text-muted'}"
			onclick={() => (activeTab = 'form')}
		>
			Inspection Form
		</button>
	</div>

	{#if activeTab === 'document'}
		<div class="tron-card p-4">
			{@render docPanel()}
		</div>
	{:else}
		<div class="tron-card p-4">
			{@render formPanel()}
		</div>
	{/if}
</div>

<!-- Tablet: stacked with collapsible doc panel (768-1023px) -->
<div class="hidden md:block lg:hidden">
	<div class="mb-3">
		<button
			type="button"
			class="tron-text-muted flex w-full items-center gap-2 text-sm hover:text-cyan-400"
			onclick={() => (docCollapsed = !docCollapsed)}
		>
			<span class="text-xs">{docCollapsed ? '>' : 'v'}</span>
			Inspection Procedure Rev {revisionNumber}
		</button>
	</div>

	{#if !docCollapsed}
		<div class="tron-card mb-4 p-4">
			{@render docPanel()}
		</div>
	{/if}

	<div class="tron-card p-4">
		{@render formPanel()}
	</div>
</div>

<!-- Desktop: side-by-side (>=1024px) -->
<div class="hidden lg:grid lg:grid-cols-2 lg:gap-4">
	<div class="tron-card overflow-y-auto p-4" style="max-height: 80vh;">
		{@render docPanel()}
	</div>
	<div class="tron-card overflow-y-auto p-4" style="max-height: 80vh;">
		{@render formPanel()}
	</div>
</div>

{#snippet docPanel()}
	<div class="mb-3 border-b border-[var(--color-tron-border)] pb-3">
		<h3 class="tron-text text-sm font-semibold">
			Inspection Procedure Rev {revisionNumber}
		</h3>
		<p class="tron-text-muted text-xs">Effective {effectiveDateStr}</p>
	</div>

	{#if htmlLoading}
		<p class="tron-text-muted py-8 text-center text-sm">Loading document...</p>
	{:else if htmlError}
		<p class="py-4 text-center text-sm text-red-400">{htmlError}</p>
	{:else if htmlContent}
		<!-- eslint-disable svelte/no-at-html-tags -->
		<div class="prose prose-sm max-w-none prose-invert">
			{@html htmlContent}
		</div>
		<!-- eslint-enable svelte/no-at-html-tags -->
	{:else if !renderedHtmlUrl}
		<p class="tron-text-muted py-8 text-center text-sm">
			No rendered document available for this revision.
		</p>
	{/if}

	{#if references.length > 0}
		<div class="mt-4 border-t border-[var(--color-tron-border)] pt-3">
			<h4 class="tron-text-muted mb-2 text-xs font-semibold uppercase">Referenced Documents</h4>
			<ul class="space-y-1">
				{#each references as ref (ref.url)}
					<li>
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<a href={ref.url} class="block text-sm text-[var(--color-tron-cyan)] hover:underline">
							{ref.label}
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- eslint-disable svelte/no-navigation-without-resolve -->
	<div class="mt-3 border-t border-[var(--color-tron-border)] pt-3">
		<a href="/spu/parts/{partId}" class="text-xs text-[var(--color-tron-cyan)] hover:underline">
			View Part Detail →
		</a>
	</div>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
{/snippet}
