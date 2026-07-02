<script lang="ts">
	/**
	 * Quick Reagent Fill Test: bulk-scan cartridge barcodes at ANY status and make
	 * them reagent-fillable (status → wax_ready, reagent fill cleared, "used for
	 * test fill" note). The scan box is a textarea so a keyboard-wedge scanner's
	 * Enter just adds a newline — focus stays put, scan many in a row.
	 */
	import { onMount } from 'svelte';
	import { deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	let boxEl = $state<HTMLTextAreaElement | null>(null);
	let text = $state('');
	let busy = $state(false);
	let result = $state<{
		converted: { barcode: string; from: string }[];
		rejected: { barcode: string; reason: string }[];
	} | null>(null);
	let errMsg = $state<string | null>(null);

	// Distinct, trimmed barcodes currently in the box (live count).
	const scanned = $derived(Array.from(new Set(text.split(/\s+/).map((s) => s.trim()).filter(Boolean))));

	onMount(() => boxEl?.focus());

	async function convert() {
		if (scanned.length === 0) { errMsg = 'Scan at least one barcode'; return; }
		errMsg = null;
		busy = true;
		try {
			const fd = new FormData();
			fd.set('barcodes', text);
			const res = await fetch('?/convert', {
				method: 'POST',
				body: fd,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const r = deserialize(await res.text());
			if (r.type === 'failure') { errMsg = (r.data as any)?.error ?? 'Failed'; return; }
			if (r.type === 'error') { errMsg = r.error?.message ?? 'Failed'; return; }
			const d = (r as any).data ?? {};
			result = { converted: d.converted ?? [], rejected: d.rejected ?? [] };
			// Keep only the rejected (not-found) barcodes in the box to fix/re-scan;
			// clear entirely on a clean run. Refocus either way.
			text = (result.rejected ?? []).map((x) => x.barcode).join('\n');
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
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Quick Reagent Fill Test</h1>
		<p class="text-xs" style="color: var(--color-tron-text-secondary)">
			Scan <em>any</em> cartridges — at <em>any</em> status — to make them reagent-fillable for a test.
			Each is set to <span class="font-mono">wax_ready</span>, its prior reagent fill is cleared, and a
			<span class="font-mono">“used for test fill”</span> note is added. Then scan them into
			<span class="font-mono">Reagent Filling</span> as normal. Just keep scanning into the box; no need to
			click between scans.
		</p>
	</div>

	<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-2 text-xs" style="color: var(--color-tron-text-secondary)">
		In the system: <span class="font-mono text-[var(--color-tron-cyan)]">{data.counts.total}</span> carts
		· already wax_ready {data.counts.wax_ready} · reagent_filled {data.counts.reagent_filled}
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
			onclick={convert}
			disabled={busy || scanned.length === 0}
			class="flex-1 rounded-lg bg-[var(--color-tron-cyan)] px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-[var(--color-tron-cyan)]/80 disabled:opacity-40"
		>
			{busy ? 'Converting…' : `Make ${scanned.length} cart${scanned.length === 1 ? '' : 's'} reagent-fillable`}
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
				✓ Made {result.converted.length} cart{result.converted.length === 1 ? '' : 's'} reagent-fillable (→ wax_ready).
			</div>
			{#if result.converted.length}
				<ul class="max-h-40 space-y-0.5 overflow-y-auto font-mono text-xs" style="color: var(--color-tron-text-secondary)">
					{#each result.converted as c (c.barcode)}
						<li>{c.barcode} <span class="opacity-60">({c.from} → wax_ready)</span></li>
					{/each}
				</ul>
			{/if}
			{#if result.rejected.length}
				<div class="rounded border border-red-500/40 bg-red-900/15 p-2 text-xs text-red-300">
					<p class="font-semibold">✗ Rejected {result.rejected.length} (kept in the box above to fix/re-scan):</p>
					<ul class="mt-1 space-y-0.5 font-mono">
						{#each result.rejected as r (r.barcode)}
							<li>{r.barcode} — {r.reason}</li>
						{/each}
					</ul>
				</div>
			{/if}
		</section>
	{/if}
</div>
