<script lang="ts">
	let { data } = $props();
</script>

<svelte:head>
	<title>WI v{data.version.version} · {data.wiTitle ?? ''}</title>
</svelte:head>

<div class="mx-auto max-w-4xl space-y-6 p-6">
	<header class="flex items-start justify-between gap-4">
		<div>
			<a href="/spu/work-instruction" class="text-xs text-[var(--color-tron-cyan)] hover:underline">
				← Back to upload
			</a>
			<h1 class="tron-text-primary mt-2 text-2xl font-bold">{data.wiTitle ?? 'SPU Work Instruction'}</h1>
			<p class="tron-text-muted text-xs">
				v{data.version.version} ·
				{data.summary.partCount} part references ·
				{data.summary.totalScans} barcode scans
				{#if data.isActive}
					<span class="ml-2 rounded bg-[var(--color-tron-cyan)] px-2 py-0.5 text-xs text-black">Active</span>
				{:else}
					<span class="ml-2 rounded border border-white/20 px-2 py-0.5 text-xs">Draft</span>
				{/if}
			</p>
			<p class="tron-text-muted mt-1 text-[10px]">
				Preview-mode: barcode inputs are disabled here. Live scanning happens on the build page.
			</p>
		</div>
	</header>

	<article class="bims-wi-document">
		{@html data.version.renderedHtml || '<p class="tron-text-muted">No rendered content for this version.</p>'}
	</article>
</div>

<style>
	:global(.bims-wi-document) {
		color: var(--color-tron-text-primary, #e6f1ff);
		line-height: 1.6;
		font-size: 0.95rem;
	}
	:global(.bims-wi-document h1),
	:global(.bims-wi-document h2),
	:global(.bims-wi-document h3),
	:global(.bims-wi-document h4) {
		color: var(--color-tron-cyan);
		font-weight: 600;
		margin-top: 1.5em;
		margin-bottom: 0.5em;
		line-height: 1.25;
	}
	:global(.bims-wi-document h1) { font-size: 1.6rem; }
	:global(.bims-wi-document h2) { font-size: 1.35rem; }
	:global(.bims-wi-document h3) { font-size: 1.15rem; }
	:global(.bims-wi-document h4) { font-size: 1rem; }
	:global(.bims-wi-document p) { margin: 0.6em 0; }
	:global(.bims-wi-document ul),
	:global(.bims-wi-document ol) {
		margin: 0.6em 0;
		padding-left: 1.6em;
	}
	:global(.bims-wi-document ul) { list-style: disc; }
	:global(.bims-wi-document ol) { list-style: decimal; }
	:global(.bims-wi-document li) { margin: 0.3em 0; }
	:global(.bims-wi-document strong),
	:global(.bims-wi-document b) { font-weight: 700; color: var(--color-tron-text-primary); }
	:global(.bims-wi-document em),
	:global(.bims-wi-document i) { font-style: italic; }
	:global(.bims-wi-document u) { text-decoration: underline; }
	:global(.bims-wi-document a) { color: var(--color-tron-cyan); text-decoration: underline; }
	:global(.bims-wi-document table) {
		width: 100%;
		border-collapse: collapse;
		margin: 1em 0;
		font-size: 0.85rem;
	}
	:global(.bims-wi-document th),
	:global(.bims-wi-document td) {
		border: 1px solid rgba(255,255,255,0.15);
		padding: 0.4em 0.6em;
		text-align: left;
		vertical-align: top;
	}
	:global(.bims-wi-document th) {
		background: rgba(255,255,255,0.04);
		font-weight: 600;
	}
	:global(.bims-wi-document img) {
		max-width: 100%;
		height: auto;
		border-radius: 6px;
		border: 1px solid rgba(255,255,255,0.1);
		margin: 0.8em 0;
		display: block;
	}
	:global(.bims-wi-document blockquote) {
		border-left: 3px solid var(--color-tron-cyan);
		padding-left: 1em;
		margin: 1em 0;
		color: var(--color-tron-text-secondary, #b0c4d4);
	}

	:global(.bims-wi-document .bims-scan-widget) {
		display: block;
		margin: 1em 0 1.5em;
		border: 1px solid var(--color-tron-cyan);
		border-radius: 8px;
		background: rgba(0, 229, 255, 0.05);
		overflow: hidden;
	}
	:global(.bims-wi-document .bims-scan-widget__header) {
		background: rgba(0, 229, 255, 0.12);
		padding: 0.5em 0.8em;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--color-tron-cyan);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		border-bottom: 1px solid rgba(0, 229, 255, 0.2);
	}
	:global(.bims-wi-document .bims-scan-widget__inputs) {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6em;
		padding: 0.8em;
	}
	:global(.bims-wi-document .bims-scan-widget__input) {
		flex: 1 1 220px;
		min-width: 180px;
	}
	:global(.bims-wi-document .bims-scan-widget__input label) {
		display: block;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-tron-text-secondary, #8aa);
		margin-bottom: 0.2em;
	}
	:global(.bims-wi-document .bims-scan-widget__input input) {
		width: 100%;
		background: rgba(0, 0, 0, 0.4);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 4px;
		padding: 0.5em 0.7em;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.85rem;
		color: var(--color-tron-text-primary, #e6f1ff);
	}
	:global(.bims-wi-document .bims-scan-widget__input input:disabled) {
		opacity: 0.55;
		cursor: not-allowed;
	}
</style>
