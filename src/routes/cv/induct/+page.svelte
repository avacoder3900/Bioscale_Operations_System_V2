<script lang="ts">
	/**
	 * /cv/induct — deliberate cartridge induction.
	 *
	 * Wedge-scanner-first: the barcode box is autofocused, Enter submits, and
	 * focus returns to the cleared box after every submit so an operator can
	 * induct a stack scan-scan-scan. The "ready for" selection is sticky between
	 * submits. An existing cartridge is reported, never mutated.
	 */
	import { onMount, tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let inputEl = $state<HTMLInputElement | null>(null);
	let barcode = $state('');
	// Sticky between submits — default to the first option (wax inspection).
	let readyFor = $state<string>(data.options[0]?.key ?? 'wax');
	let busy = $state(false);

	const selectedOption = $derived(data.options.find((o) => o.key === readyFor));

	onMount(() => inputEl?.focus());

	function fmt(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return isNaN(d.getTime()) ? '—' : d.toLocaleString();
	}
</script>

<div class="mx-auto max-w-3xl space-y-6">
	<div>
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Induct Cartridge</h1>
		<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
			Scan an unmade cartridge's barcode to create a real record, ready for the inspection you
			choose. Unlike the old auto-induct, this is deliberate — a chosen readiness status and an audit
			trail, never a blank ghost. Scanning a cartridge that already exists just reports it; it is
			never changed.
		</p>
	</div>

	<!-- Ready-for selector (sticky between scans) -->
	<fieldset class="space-y-2">
		<legend class="text-xs font-medium uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
			Make cartridge ready for
		</legend>
		<div class="grid gap-2 sm:grid-cols-3">
			{#each data.options as opt (opt.key)}
				<label
					class="flex cursor-pointer flex-col gap-1 rounded-lg border p-3 transition-colors"
					style="border-color: {readyFor === opt.key
						? 'var(--color-tron-cyan)'
						: 'var(--color-tron-border)'}; background: {readyFor === opt.key
						? 'rgba(0, 224, 255, 0.08)'
						: 'transparent'}"
				>
					<span class="flex items-center gap-2">
						<input type="radio" name="readyForSel" value={opt.key} bind:group={readyFor} class="accent-[var(--color-tron-cyan)]" />
						<span class="text-sm font-semibold" style="color: var(--color-tron-text)">{opt.label}</span>
					</span>
					<span class="font-mono text-[11px]" style="color: var(--color-tron-cyan)">→ {opt.status}</span>
					<span class="text-[11px] leading-snug" style="color: var(--color-tron-text-secondary)">{opt.blurb}</span>
				</label>
			{/each}
		</div>
	</fieldset>

	<!-- Scan input -->
	<form
		method="POST"
		action="?/induct"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				// Keep the sticky readyFor selection; reset only the form's own state.
				await update({ reset: true });
				barcode = '';
				busy = false;
				await invalidateAll();
				await tick();
				inputEl?.focus();
			};
		}}
	>
		<input type="hidden" name="readyFor" value={readyFor} />
		<label class="block">
			<span class="text-xs font-medium uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
				Scan barcode {#if selectedOption}<span class="normal-case" style="color: var(--color-tron-text-secondary)">— will induct at <span class="font-mono" style="color: var(--color-tron-cyan)">{selectedOption.status}</span></span>{/if}
			</span>
			<input
				bind:this={inputEl}
				bind:value={barcode}
				name="barcode"
				autocomplete="off"
				placeholder="Scan or type a cartridge barcode, then Enter…"
				disabled={busy}
				class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-3 py-3 font-mono text-base disabled:opacity-40"
				style="color: var(--color-tron-text)"
			/>
		</label>
	</form>

	<!-- Feedback line -->
	{#if form?.error}
		<div class="rounded border border-red-500/40 bg-red-900/20 p-3 text-sm text-red-300">{form.error}</div>
	{:else if form?.inducted}
		<div class="rounded border border-green-500/40 bg-green-900/15 p-3 text-sm text-green-300">
			Inducted <span class="font-mono">{form.barcode}</span> at
			<span class="font-mono">{form.status}</span> — ready for {form.readyForLabel}.
		</div>
	{:else if form?.exists}
		<div class="rounded border border-yellow-500/40 bg-yellow-900/15 p-3 text-sm text-yellow-200">
			<div>
				<span class="font-mono">{form.barcode}</span> already exists — current status
				<span class="font-mono text-[var(--color-tron-cyan)]">{form.currentStatus}</span>. Not changed.
			</div>
			{#if form.phaseHistory?.length}
				<div class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
					Phase history: {#each form.phaseHistory as p, i (p.phase)}{i > 0 ? ' · ' : ''}<span class="font-mono">{p.phase}</span>{/each}
				</div>
			{:else}
				<div class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">No recorded phase stamps yet.</div>
			{/if}
		</div>
	{/if}

	<!-- Recently inducted -->
	<section class="space-y-2">
		<h2 class="text-xs font-medium uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
			Recently inducted
		</h2>
		{#if data.recentlyInducted.length === 0}
			<p class="text-xs" style="color: var(--color-tron-text-secondary)">Nothing inducted yet.</p>
		{:else}
			<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)]">
				<table class="w-full text-left text-xs">
					<thead style="color: var(--color-tron-text-secondary)">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="px-3 py-2 font-medium">Barcode</th>
							<th class="px-3 py-2 font-medium">Current status</th>
							<th class="px-3 py-2 font-medium">Inducted at</th>
							<th class="px-3 py-2 font-medium">When</th>
							<th class="px-3 py-2 font-medium">By</th>
						</tr>
					</thead>
					<tbody style="color: var(--color-tron-text)">
						{#each data.recentlyInducted as row (row.barcode)}
							<tr class="border-b border-[var(--color-tron-border)]/50">
								<td class="px-3 py-2 font-mono">{row.barcode}</td>
								<td class="px-3 py-2 font-mono" style="color: var(--color-tron-cyan)">{row.currentStatus}</td>
								<td class="px-3 py-2 font-mono" style="color: var(--color-tron-text-secondary)">{row.inductedStatus ?? '—'}</td>
								<td class="px-3 py-2" style="color: var(--color-tron-text-secondary)">{fmt(row.at)}</td>
								<td class="px-3 py-2" style="color: var(--color-tron-text-secondary)">{row.by ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>
