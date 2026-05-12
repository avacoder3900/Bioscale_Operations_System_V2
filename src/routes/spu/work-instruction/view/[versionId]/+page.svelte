<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	let { data, form } = $props();

	let articleEl: HTMLElement | undefined = $state();

	function refreshGating(root: HTMLElement) {
		const stepEls = Array.from(root.querySelectorAll<HTMLElement>('.bims-wi-step'));
		let prevSatisfied = true;
		for (const el of stepEls) {
			const required = parseInt(el.dataset.requiredScans ?? '0', 10) || 0;
			const inputs = el.querySelectorAll<HTMLInputElement>('.bims-wi-step__scan-input');
			let filled = 0;
			inputs.forEach((inp) => {
				if (inp.value.trim().length > 0) filled++;
			});
			const locked = !prevSatisfied;
			el.classList.toggle('is-locked', locked);
			el.classList.toggle('is-complete', required > 0 && filled >= required);
			inputs.forEach((inp) => {
				inp.disabled = locked;
			});
			const stepSatisfied = required === 0 ? true : filled >= required;
			if (!stepSatisfied) prevSatisfied = false;
		}
	}

	onMount(() => {
		if (!articleEl) return;
		refreshGating(articleEl);
		const handler = () => articleEl && refreshGating(articleEl);
		articleEl.addEventListener('input', handler);
		return () => articleEl?.removeEventListener('input', handler);
	});
</script>

<svelte:head>
	<title>WI v{data.version.version} · {data.wiTitle ?? ''}</title>
</svelte:head>

<div class="mx-auto max-w-7xl space-y-6 p-6">
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

	<article class="bims-wi-document" bind:this={articleEl}>
		{@html data.version.renderedHtml || '<p class="tron-text-muted">No rendered content for this version.</p>'}
	</article>

	{#if (form as any)?.error}
		<div class="rounded-lg border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{(form as any).error}</p>
		</div>
	{/if}

	{#if data.canApprove && !data.isActive}
		<div class="flex flex-wrap items-center gap-3 border-t border-white/10 pt-6">
			<p class="tron-text-muted mr-auto text-xs">
				Confirm this work instruction is correct, then activate it for the build floor.
			</p>
			<form method="POST" action="?/induct" use:enhance>
				<input type="hidden" name="wiId" value={data.wiId} />
				<button
					type="submit"
					class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black hover:opacity-90"
				>
					Confirm &amp; Activate
				</button>
			</form>
			<form method="POST" action="?/reject" use:enhance>
				<input type="hidden" name="wiId" value={data.wiId} />
				<button
					type="submit"
					class="rounded-lg border border-[var(--color-tron-red)] px-4 py-2 text-sm text-[var(--color-tron-red)] hover:bg-[rgba(255,51,102,0.1)]"
				>
					Reject
				</button>
			</form>
		</div>
	{/if}
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

	/* === Procedure step rows (parser v3.1: doc on left, scans on right) === */
	:global(.bims-wi-document .bims-wi-steps) {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	:global(.bims-wi-document .bims-wi-step) {
		display: grid;
		grid-template-columns: minmax(0, 1.6fr) minmax(280px, 1fr);
		gap: 1rem;
		padding: 0.85rem 1rem;
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 10px;
		background: rgba(0, 0, 0, 0.25);
		transition: opacity 0.2s ease, border-color 0.2s ease;
	}
	:global(.bims-wi-document .bims-wi-step.is-locked) {
		opacity: 0.45;
		pointer-events: none;
	}
	:global(.bims-wi-document .bims-wi-step.is-complete) {
		border-color: var(--color-tron-cyan);
		background: rgba(0, 229, 255, 0.06);
	}
	:global(.bims-wi-document .bims-wi-step__doc) {
		display: grid;
		grid-template-columns: 64px minmax(0, 1fr);
		gap: 0.75rem;
		align-items: start;
		min-width: 0;
	}
	:global(.bims-wi-document .bims-wi-step__num) {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 700;
		font-size: 1rem;
		color: var(--color-tron-cyan);
		padding: 0.3rem 0.5rem;
		background: rgba(0, 229, 255, 0.1);
		border: 1px solid rgba(0, 229, 255, 0.3);
		border-radius: 6px;
		text-align: center;
		align-self: start;
	}
	:global(.bims-wi-document .bims-wi-step__num p) { margin: 0; }
	:global(.bims-wi-document .bims-wi-step__instruction) {
		font-size: 0.95rem;
		line-height: 1.55;
		min-width: 0;
	}
	:global(.bims-wi-document .bims-wi-step__instruction p:first-child) { margin-top: 0; }
	:global(.bims-wi-document .bims-wi-step__instruction p:last-child) { margin-bottom: 0; }
	:global(.bims-wi-document .bims-wi-step__instruction img) {
		max-width: 100%;
		height: auto;
		margin: 0.5em 0;
	}
	:global(.bims-wi-document .bims-wi-step__scans) {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding-left: 1rem;
		border-left: 1px dashed rgba(255, 255, 255, 0.12);
	}
	:global(.bims-wi-document .bims-wi-step__scans--none) {
		align-items: flex-start;
		justify-content: center;
		color: var(--color-tron-text-secondary, #8aa);
	}
	:global(.bims-wi-document .bims-wi-step__no-scans) {
		display: inline-block;
		padding: 0.3rem 0.6rem;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-style: italic;
		border: 1px dashed rgba(255, 255, 255, 0.2);
		border-radius: 999px;
		color: var(--color-tron-text-secondary, #8aa);
	}
	:global(.bims-wi-document .bims-wi-step__scan label) {
		display: block;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-tron-text-secondary, #8aa);
		margin-bottom: 0.25rem;
	}
	:global(.bims-wi-document .bims-wi-step__scan-input) {
		width: 100%;
		background: rgba(0, 0, 0, 0.5);
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 5px;
		padding: 0.55em 0.75em;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.9rem;
		color: var(--color-tron-text-primary, #e6f1ff);
	}
	:global(.bims-wi-document .bims-wi-step__scan-input:disabled) {
		opacity: 0.4;
		cursor: not-allowed;
	}
	:global(.bims-wi-document .bims-wi-step__scan-input:focus) {
		outline: none;
		border-color: var(--color-tron-cyan);
		box-shadow: 0 0 0 2px rgba(0, 229, 255, 0.3);
	}
	@media (max-width: 900px) {
		:global(.bims-wi-document .bims-wi-step) {
			grid-template-columns: 1fr;
		}
		:global(.bims-wi-document .bims-wi-step__scans) {
			padding-left: 0;
			border-left: 0;
			padding-top: 0.7rem;
			border-top: 1px dashed rgba(255, 255, 255, 0.12);
		}
	}
</style>
