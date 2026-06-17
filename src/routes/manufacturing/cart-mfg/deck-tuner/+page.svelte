<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let selectedDeck = $state(data.selected ?? '');
	let selectedWell = $state('');
	let dx = $state(0);
	let dy = $state(0);
	let dz = $state(0);
	let submitting = $state(false);

	const well = $derived(data.wells.find((w: any) => w.name === selectedWell) ?? null);

	function pickDeck(loadName: string) {
		selectedDeck = loadName;
		selectedWell = '';
		const url = new URL($page.url);
		if (loadName) url.searchParams.set('deck', loadName);
		else url.searchParams.delete('deck');
		goto(url.pathname + url.search, { invalidateAll: true });
	}
</script>

<div class="space-y-6">
	<div>
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Deck Tuner</h1>
		<p class="text-sm text-[var(--color-tron-text-secondary)]">
			Nudge a deck hole's X/Y/Z and save it into the deck definition — no hand-editing JSON.
			Changes go to Mongo (bundled to the robot on the next protocol upload) with full history.
		</p>
	</div>

	<div class="grid gap-4 sm:grid-cols-2">
		<div>
			<label for="deckSel" class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Deck</label>
			<select
				id="deckSel"
				value={selectedDeck}
				onchange={(e) => pickDeck(e.currentTarget.value)}
				class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)]"
			>
				<option value="">— Select deck —</option>
				{#each data.decks as d (d.loadName)}
					<option value={d.loadName}>{d.loadName}</option>
				{/each}
			</select>
		</div>

		{#if data.selected}
			<div>
				<label for="wellSel" class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Hole ({data.wells.length})</label>
				<select
					id="wellSel"
					bind:value={selectedWell}
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 font-mono text-[var(--color-tron-text)]"
				>
					<option value="">— Select hole —</option>
					{#each data.wells as w (w.name)}
						<option value={w.name}>{w.name} — ({w.x.toFixed(2)}, {w.y.toFixed(2)}, {w.z.toFixed(2)})</option>
					{/each}
				</select>
			</div>
		{/if}
	</div>

	{#if data.selected && well}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<p class="text-sm font-semibold text-[var(--color-tron-text)]">
				Hole <span class="font-mono text-[var(--color-tron-cyan)]">{well.name}</span>
			</p>
			<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				Current: x=<span class="font-mono">{well.x.toFixed(3)}</span>
				y=<span class="font-mono">{well.y.toFixed(3)}</span>
				z=<span class="font-mono">{well.z.toFixed(3)}</span> mm
			</p>

			<form
				method="POST"
				action="?/applyEdit"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						await update({ reset: false });
						submitting = false;
						dx = 0; dy = 0; dz = 0;
					};
				}}
				class="mt-4 space-y-3"
			>
				<input type="hidden" name="deckLoadName" value={data.selected} />
				<input type="hidden" name="wellName" value={well.name} />
				<div class="grid grid-cols-3 gap-3">
					<label class="text-xs text-[var(--color-tron-text-secondary)]">Nudge X (mm)
						<input type="number" step="0.01" name="dx" bind:value={dx} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-2 py-2 text-center font-mono text-[var(--color-tron-text)]" />
					</label>
					<label class="text-xs text-[var(--color-tron-text-secondary)]">Nudge Y (mm)
						<input type="number" step="0.01" name="dy" bind:value={dy} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-2 py-2 text-center font-mono text-[var(--color-tron-text)]" />
					</label>
					<label class="text-xs text-[var(--color-tron-text-secondary)]">Nudge Z (mm)
						<input type="number" step="0.01" name="dz" bind:value={dz} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-2 py-2 text-center font-mono text-[var(--color-tron-text)]" />
					</label>
				</div>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">
					New: x=<span class="font-mono">{(well.x + (Number(dx) || 0)).toFixed(3)}</span>
					y=<span class="font-mono">{(well.y + (Number(dy) || 0)).toFixed(3)}</span>
					z=<span class="font-mono">{(well.z + (Number(dz) || 0)).toFixed(3)}</span>
				</p>
				<button
					type="submit"
					disabled={submitting}
					class="rounded-lg bg-[var(--color-tron-cyan)] px-6 py-2 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
				>
					{submitting ? 'Saving…' : 'Apply nudge'}
				</button>
			</form>

			{#if form?.error}
				<p class="mt-2 text-sm text-[var(--color-tron-error)]">{form.error}</p>
			{:else if form?.success}
				<p class="mt-2 text-sm text-green-400">
					Saved {form.wellName}: x={form.after.x.toFixed(3)} y={form.after.y.toFixed(3)} z={form.after.z.toFixed(3)}
					{form.fileSynced ? ' · local JSON synced' : ' · Mongo only (local JSON dir not present)'}
				</p>
			{/if}
		</div>
	{/if}

	{#if data.history.length > 0}
		<div class="border-t border-[var(--color-tron-border)] pt-4">
			<h2 class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Edit history</h2>
			<div class="mt-2 overflow-x-auto">
				<table class="w-full text-left text-xs">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]">
							<th class="px-2 py-1">Hole</th>
							<th class="px-2 py-1">Δ (x,y,z)</th>
							<th class="px-2 py-1">After (x,y,z)</th>
							<th class="px-2 py-1">By</th>
							<th class="px-2 py-1">When</th>
						</tr>
					</thead>
					<tbody>
						{#each data.history as h (h.createdAt + h.wellName)}
							<tr class="border-b border-[var(--color-tron-border)] font-mono">
								<td class="px-2 py-1 text-[var(--color-tron-cyan)]">{h.wellName}</td>
								<td class="px-2 py-1">{h.delta.x.toFixed(2)}, {h.delta.y.toFixed(2)}, {h.delta.z.toFixed(2)}</td>
								<td class="px-2 py-1">{h.after.x.toFixed(2)}, {h.after.y.toFixed(2)}, {h.after.z.toFixed(2)}</td>
								<td class="px-2 py-1 text-[var(--color-tron-text-secondary)]">{h.createdBy}</td>
								<td class="px-2 py-1 text-[var(--color-tron-text-secondary)]">{h.createdAt ? new Date(h.createdAt).toLocaleString() : ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>
