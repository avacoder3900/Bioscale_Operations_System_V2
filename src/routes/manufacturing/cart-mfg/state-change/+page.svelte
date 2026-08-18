<script lang="ts">
	/**
	 * Cartridge State Change: bulk-scan cartridge barcodes and move them all to
	 * one target status. The scan box is a textarea so a keyboard-wedge scanner's
	 * Enter just adds a newline — focus stays put, scan many in a row.
	 *
	 * Replaces the old Quick Reagent Fill Test page (that shortcut = target
	 * `wax_ready` + "Clear reagent fill" ticked).
	 */
	import { onMount } from 'svelte';
	import { deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	let boxEl = $state<HTMLTextAreaElement | null>(null);
	let text = $state('');
	let target = $state('');
	let createUnknown = $state(false);
	let clearReagentFill = $state(false);
	let reason = $state('');
	let busy = $state(false);
	let result = $state<{
		target: string;
		changed: { barcode: string; from: string }[];
		unchanged: { barcode: string; reason: string }[];
		rejected: { barcode: string; reason: string }[];
	} | null>(null);
	let errMsg = $state<string | null>(null);

	// Distinct, trimmed barcodes currently in the box (live count).
	const scanned = $derived(Array.from(new Set(text.split(/\s+/).map((s) => s.trim()).filter(Boolean))));

	onMount(() => boxEl?.focus());

	async function changeState() {
		if (!target) { errMsg = 'Pick a target status'; return; }
		if (scanned.length === 0) { errMsg = 'Scan at least one barcode'; return; }
		errMsg = null;
		busy = true;
		try {
			const fd = new FormData();
			fd.set('barcodes', text);
			fd.set('targetStatus', target);
			if (createUnknown) fd.set('createUnknown', 'on');
			if (clearReagentFill) fd.set('clearReagentFill', 'on');
			if (reason.trim()) fd.set('reason', reason.trim());
			const res = await fetch('?/changeState', {
				method: 'POST',
				body: fd,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const r = deserialize(await res.text());
			if (r.type === 'failure') { errMsg = (r.data as any)?.error ?? 'Failed'; return; }
			if (r.type === 'error') { errMsg = r.error?.message ?? 'Failed'; return; }
			const d = (r as any).data ?? {};
			result = {
				target: d.target ?? target,
				changed: d.changed ?? [],
				unchanged: d.unchanged ?? [],
				rejected: d.rejected ?? []
			};
			// Keep only the rejected barcodes in the box to fix/re-scan; clear
			// entirely on a clean run. Refocus either way.
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
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">State Change</h1>
		<p class="text-xs" style="color: var(--color-tron-text-secondary)">
			Scan <em>any</em> cartridges — at <em>any</em> status — and move them all to one target status.
			Each gets its prior status recorded, a note, and an audit entry. Just keep scanning into the box;
			no need to click between scans.
		</p>
	</div>

	<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-2 text-xs" style="color: var(--color-tron-text-secondary)">
		In the system: <span class="font-mono text-[var(--color-tron-cyan)]">{data.total}</span> carts
		{#if target}
			· currently <span class="font-mono">{target}</span>:
			<span class="font-mono text-[var(--color-tron-cyan)]">{data.counts[target] ?? 0}</span>
		{/if}
	</div>

	{#if errMsg}<div class="rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">{errMsg}</div>{/if}

	<label class="block">
		<span class="text-xs font-medium uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
			Target status
		</span>
		<select
			bind:value={target}
			class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-3 py-2 font-mono text-sm"
			style="color: var(--color-tron-text)"
		>
			<option value="">— pick a status —</option>
			{#each data.statuses as s (s)}
				<option value={s}>{s}{data.counts[s] ? ` (${data.counts[s]} now)` : ''}</option>
			{/each}
		</select>
	</label>

	<label class="block">
		<span class="text-xs font-medium uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
			Reason (optional — goes on the note + audit entry)
		</span>
		<input
			bind:value={reason}
			placeholder="e.g. re-work batch, test fill, scrapped after drop"
			class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-3 py-2 text-sm"
			style="color: var(--color-tron-text)"
		/>
	</label>

	<div class="space-y-1 rounded border border-[var(--color-tron-border)] bg-black/20 p-2 text-xs" style="color: var(--color-tron-text-secondary)">
		<label class="flex items-center gap-2">
			<input type="checkbox" bind:checked={createUnknown} />
			<span>Create unknown barcodes (otherwise they are rejected, nothing is written)</span>
		</label>
		<label class="flex items-center gap-2">
			<input type="checkbox" bind:checked={clearReagentFill} />
			<span>Clear reagent fill (the old Quick Rgt Test behaviour — pair with <span class="font-mono">wax_ready</span>)</span>
		</label>
	</div>

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
			onclick={changeState}
			disabled={busy || scanned.length === 0 || !target}
			class="flex-1 rounded-lg bg-[var(--color-tron-cyan)] px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-[var(--color-tron-cyan)]/80 disabled:opacity-40"
		>
			{busy
				? 'Changing…'
				: `Set ${scanned.length} cart${scanned.length === 1 ? '' : 's'} → ${target || 'status'}`}
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
				✓ Changed {result.changed.length} cart{result.changed.length === 1 ? '' : 's'} → {result.target}.
			</div>
			{#if result.changed.length}
				<ul class="max-h-40 space-y-0.5 overflow-y-auto font-mono text-xs" style="color: var(--color-tron-text-secondary)">
					{#each result.changed as c (c.barcode)}
						<li>{c.barcode} <span class="opacity-60">({c.from} → {result.target})</span></li>
					{/each}
				</ul>
			{/if}
			{#if result.unchanged.length}
				<div class="rounded border border-[var(--color-tron-border)] bg-black/20 p-2 text-xs" style="color: var(--color-tron-text-secondary)">
					<p class="font-semibold">• Skipped {result.unchanged.length} (already at the target):</p>
					<ul class="mt-1 space-y-0.5 font-mono">
						{#each result.unchanged as u (u.barcode)}
							<li>{u.barcode} — {u.reason}</li>
						{/each}
					</ul>
				</div>
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
