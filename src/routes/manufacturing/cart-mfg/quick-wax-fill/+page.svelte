<script lang="ts">
	/**
	 * Quick Wax Fill: bulk-scan cartridge barcodes and land them all at
	 * `wax_filled`, the state right after the wax fill. Barcodes that don't exist
	 * yet are CREATED at wax_filled; existing carts are moved from wherever they are.
	 * The scan box is a textarea so a keyboard-wedge scanner's Enter just adds a
	 * newline — focus stays put, scan many in a row.
	 */
	import { onMount } from 'svelte';
	import { deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	let boxEl = $state<HTMLTextAreaElement | null>(null);
	let text = $state('');
	let busy = $state(false);
	let result = $state<{
		created: string[];
		advanced: { barcode: string; from: string }[];
		failed: { barcode: string; reason: string }[];
	} | null>(null);
	let errMsg = $state<string | null>(null);

	const scanned = $derived(Array.from(new Set(text.split(/\s+/).map((s) => s.trim()).filter(Boolean))));

	onMount(() => boxEl?.focus());

	async function fill() {
		if (scanned.length === 0) { errMsg = 'Scan at least one barcode'; return; }
		errMsg = null;
		busy = true;
		try {
			const fd = new FormData();
			fd.set('barcodes', text);
			const res = await fetch('?/fill', {
				method: 'POST',
				body: fd,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const r = deserialize(await res.text());
			if (r.type === 'failure') { errMsg = (r.data as any)?.error ?? 'Failed'; return; }
			if (r.type === 'error') { errMsg = r.error?.message ?? 'Failed'; return; }
			const d = (r as any).data ?? {};
			result = { created: d.created ?? [], advanced: d.advanced ?? [], failed: d.failed ?? [] };
			// Keep only failed barcodes in the box to fix/re-scan; clear on a clean run.
			text = (result.failed ?? []).map((x) => x.barcode).join('\n');
			await invalidateAll();
		} catch (e) {
			errMsg = e instanceof Error ? e.message : 'Request failed';
		} finally {
			busy = false;
			boxEl?.focus();
		}
	}

	function clearAll() {
		text = '';
		result = null;
		errMsg = null;
		boxEl?.focus();
	}
</script>

<div class="mx-auto max-w-2xl space-y-4 p-4">
	<div>
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Quick Wax Fill</h1>
		<p class="text-xs" style="color: var(--color-tron-text-secondary)">
			Scan cartridges to land them all at <span class="font-mono">wax_filled</span> — the state right after
			the wax fill. Barcodes that <em>don't exist yet are created</em> on the spot at
			<span class="font-mono">wax_filled</span>; existing carts are moved from wherever they are. Each gets a
			<span class="font-mono">“Quick Wax Fill”</span> note. Just keep scanning into the box; no need to click
			between scans.
		</p>
	</div>

	<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-2 text-xs" style="color: var(--color-tron-text-secondary)">
		In the system: <span class="font-mono text-[var(--color-tron-cyan)]">{data.counts.total}</span> carts
		· already wax_filled {data.counts.wax_filled}
	</div>

	{#if errMsg}<div class="rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">{errMsg}</div>{/if}

	<label class="block">
		<span class="text-xs font-medium uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
			Scan cartridges — one per line
		</span>
		<textarea
			bind:this={boxEl}
			bind:value={text}
			rows="12"
			placeholder="Scan barcodes here…"
			class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-3 py-2 font-mono text-sm"
			style="color: var(--color-tron-text)"
		></textarea>
	</label>

	<div class="flex items-center gap-3">
		<button
			type="button"
			onclick={fill}
			disabled={busy || scanned.length === 0}
			class="flex-1 rounded-lg bg-[var(--color-tron-cyan)] px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-[var(--color-tron-cyan)]/80 disabled:opacity-40"
		>
			{busy ? 'Filling…' : `Set ${scanned.length} cart${scanned.length === 1 ? '' : 's'} → wax_filled`}
		</button>
		<button
			type="button"
			onclick={clearAll}
			disabled={busy}
			class="rounded border border-[var(--color-tron-border)] px-4 py-3 text-sm hover:border-[var(--color-tron-cyan)] disabled:opacity-40"
			style="color: var(--color-tron-text)"
		>
			Clear
		</button>
	</div>

	{#if result}
		<section class="space-y-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<div class="rounded border border-green-500/40 bg-green-900/15 p-2 text-sm text-green-300">
				✓ {result.created.length + result.advanced.length} cart{result.created.length + result.advanced.length === 1 ? '' : 's'} at wax_filled
				— {result.created.length} created, {result.advanced.length} moved.
			</div>
			{#if result.created.length}
				<div>
					<p class="text-xs font-semibold" style="color: var(--color-tron-text-secondary)">Created ({result.created.length}):</p>
					<ul class="mt-1 max-h-40 space-y-0.5 overflow-y-auto font-mono text-xs" style="color: var(--color-tron-text-secondary)">
						{#each result.created as b (b)}
							<li>{b} <span class="opacity-60">(new → wax_filled)</span></li>
						{/each}
					</ul>
				</div>
			{/if}
			{#if result.advanced.length}
				<div>
					<p class="text-xs font-semibold" style="color: var(--color-tron-text-secondary)">Moved ({result.advanced.length}):</p>
					<ul class="mt-1 max-h-40 space-y-0.5 overflow-y-auto font-mono text-xs" style="color: var(--color-tron-text-secondary)">
						{#each result.advanced as c (c.barcode)}
							<li>{c.barcode} <span class="opacity-60">({c.from} → wax_filled)</span></li>
						{/each}
					</ul>
				</div>
			{/if}
			{#if result.failed.length}
				<div class="rounded border border-red-500/40 bg-red-900/15 p-2 text-xs text-red-300">
					<p class="font-semibold">✗ Failed {result.failed.length} (kept in the box above to fix/re-scan):</p>
					<ul class="mt-1 space-y-0.5 font-mono">
						{#each result.failed as f (f.barcode)}
							<li>{f.barcode} — {f.reason}</li>
						{/each}
					</ul>
				</div>
			{/if}
		</section>
	{/if}
</div>
