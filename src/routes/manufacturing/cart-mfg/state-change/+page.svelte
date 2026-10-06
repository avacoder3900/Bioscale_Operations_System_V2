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
	import BadgeScanField from '$lib/components/manufacturing/BadgeScanField.svelte';

	let { data } = $props();

	let boxEl = $state<HTMLTextAreaElement | null>(null);
	let text = $state('');
	let target = $state('');
	let createUnknown = $state(false);
	let clearReagentFill = $state(false);
	let reason = $state('');
	// Bucket stages need a destination bucket (its open pass at that stage).
	let destinationBucketId = $state('');
	// "No bucket": only for the Backed target — straight to status 'backing' on no pass.
	let noBucket = $state(false);
	const isBucketTarget = $derived((data.bucketStages as string[]).includes(target));
	const isBackedTarget = $derived(target === data.backedStage);
	const needsBucket = $derived(isBucketTarget && !(isBackedTarget && noBucket));
	const passesAtTarget = $derived(isBucketTarget ? (data.openPasses as any[]).filter((p) => p.stage === target) : []);
	let busy = $state(false);
	let result = $state<{
		target: string;
		changed: { barcode: string; from: string }[];
		unchanged: { barcode: string; reason: string }[];
		rejected: { barcode: string; reason: string }[];
	} | null>(null);
	let errMsg = $state<string | null>(null);

	// Badge (2026-10-05): a cart entering or leaving a bucket pass is a badge-gated
	// bucket step. Scanned into its own box, or into the cart box — a BDG- code
	// there is the badge, not a cart (the server routes it the same way).
	const BADGE_RE = /^BDG-[A-Z0-9]{10}$/i;
	let badge = $state('');
	const badgeRequired = $derived(data.badgeMode === 'required');

	// Distinct, trimmed codes currently in the box; the cart count leaves a badge out.
	const codesInBox = $derived(Array.from(new Set(text.split(/\s+/).map((s) => s.trim()).filter(Boolean))));
	const scanned = $derived(codesInBox.filter((c) => !BADGE_RE.test(c)));

	onMount(() => boxEl?.focus());

	async function changeState() {
		if (!target) { errMsg = 'Pick a target status'; return; }
		if (needsBucket && !destinationBucketId) { errMsg = `${data.stageLabels[target] ?? target} is a bucket stage — pick the destination bucket${isBackedTarget ? ' or tick "No bucket"' : ''}`; return; }
		if (scanned.length === 0) { errMsg = 'Scan at least one barcode'; return; }
		// A badge scanned into the cart box moves to the badge box, so it stays on for the next batch.
		const badgeInBox = codesInBox.find((c) => BADGE_RE.test(c));
		if (badgeInBox && !badge.trim()) badge = badgeInBox;
		if (badgeRequired && isBucketTarget && !badge.trim()) { errMsg = 'Scan your badge — moving carts into a bucket stage needs one.'; document.getElementById('badgeStateChange')?.focus(); return; }
		errMsg = null;
		busy = true;
		try {
			const fd = new FormData();
			fd.set('barcodes', scanned.join('\n'));
			fd.set('badge', badge.trim());
			fd.set('targetStatus', target);
			if (createUnknown) fd.set('createUnknown', 'on');
			if (needsBucket && destinationBucketId) fd.set('destinationBucketId', destinationBucketId);
			if (isBackedTarget && noBucket) fd.set('noBucket', 'on');
			if (clearReagentFill) fd.set('clearReagentFill', 'on');
			if (reason.trim()) fd.set('reason', reason.trim());
			const res = await fetch('?/changeState', {
				method: 'POST',
				body: fd,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const r = deserialize(await res.text());
			if (r.type === 'failure') {
				errMsg = (r.data as any)?.error ?? 'Failed';
				// A refused badge (unknown, revoked, not allowed) is cleared so the next scan replaces it.
				const code = (r.data as any)?.code;
				if (typeof code === 'string' && code.startsWith('BADGE')) badge = '';
				return;
			}
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
				<option value={s}>{s}{(data.bucketStages as string[]).includes(s) ? ' · bucket stage' : ''}{data.counts[s] ? ` (${data.counts[s]} now)` : ''}</option>
			{/each}
		</select>
	</label>

	{#if isBucketTarget}
		{#if isBackedTarget}
			<label class="flex items-start gap-2 rounded border border-[var(--color-tron-border)] bg-black/20 p-2 text-xs" style="color: var(--color-tron-text-secondary)">
				<input type="checkbox" bind:checked={noBucket} class="mt-0.5" />
				<span>
					<span class="font-semibold" style="color: var(--color-tron-text)">No bucket</span> — move straight to {data.stageLabels[target] ?? target}.
					The carts sit loose at <span class="font-mono">backing</span>, where <em>Move to oven</em> leaves them: counted as Backed, listed under the board's <em>In oven</em> dropdown, loadable by wax filling.
				</span>
			</label>
		{/if}
		{#if needsBucket}
			<label class="block">
				<span class="text-xs font-medium uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
					Destination bucket — its open pass must be at {data.stageLabels[target] ?? target}
				</span>
				<select
					bind:value={destinationBucketId}
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-3 py-2 font-mono text-sm"
					style="color: var(--color-tron-text)"
				>
					<option value="">{passesAtTarget.length ? '— pick a bucket —' : `— no open pass is at ${data.stageLabels[target] ?? target} —`}</option>
					{#each passesAtTarget as p (p.cycleId)}
						<option value={p.bucketId}>{p.bucketId} #{p.cycleNumber}{p.barcode ? ` · ${p.barcode.slice(0, 8)}…` : ''} · {p.quantity} cart{p.quantity === 1 ? '' : 's'}</option>
					{/each}
				</select>
				<p class="mt-1 text-[10px]" style="color: var(--color-tron-text-secondary)">
					The carts join that bucket's pass (and leave their old one). Nothing is debited — an override is bookkeeping. Unknown barcodes are refused here; scan them into a bucket on the <a href="/manufacturing/cart-mfg/buckets" class="underline">board</a> instead.
				</p>
			</label>
		{:else}
			<p class="text-[10px]" style="color: var(--color-tron-text-secondary)">
				A cart that is currently in a bucket pass leaves it. Nothing is debited — an override is bookkeeping. Unknown barcodes are still refused here.
			</p>
		{/if}
	{:else if target}
		<p class="text-[10px]" style="color: var(--color-tron-text-secondary)">A cart that is currently in a bucket (Barcoded / Unpressed / Backed) is removed from its bucket's pass when moved here.</p>
	{/if}

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

	<!-- Badge-gated bucket step (2026-10-05): asked for whenever enforcement is on,
	     required only for carts that enter or leave a bucket pass. -->
	<BadgeScanField
		bind:value={badge}
		show={badgeRequired}
		required={false}
		id="badgeStateChange"
		label="Scan your badge — needed when a cart enters or leaves a bucket"
		class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-3 py-2 text-sm text-[var(--color-tron-text)]"
		onscanned={() => boxEl?.focus()}
	/>

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
