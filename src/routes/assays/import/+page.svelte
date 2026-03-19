<script lang="ts">
	import { enhance } from '$app/forms';
	import ImportPreview from '$lib/components/assay/ImportPreview.svelte';

	let { form } = $props();

	let selected = $state(new Set<number>());
	let importing = $state(false);

	const previews = $derived(form?.previews ?? []);
	const importResult = $derived(form?.importResult ?? null);
	const error = $derived(form?.error ?? null);

	function toggleSelection(index: number) {
		const next = new Set(selected);
		if (next.has(index)) {
			next.delete(index);
		} else {
			next.add(index);
		}
		selected = next;
	}

	function toggleAll() {
		const validIndices = previews
			.map((p: { valid: boolean }, i: number) => (p.valid ? i : -1))
			.filter((i: number) => i >= 0);
		const allSelected = validIndices.every((i: number) => selected.has(i));

		if (allSelected) {
			selected = new Set();
		} else {
			selected = new Set(validIndices);
		}
	}

	// Auto-select all valid previews when they first load
	$effect(() => {
		if (previews.length > 0 && selected.size === 0) {
			const validIndices = previews
				.map((p: { valid: boolean }, i: number) => (p.valid ? i : -1))
				.filter((i: number) => i >= 0);
			selected = new Set(validIndices);
		}
	});
</script>

<div class="mx-auto max-w-3xl space-y-6 p-4">
	<div>
		<a href="/assays" class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
			&larr; Back to Assays
		</a>
		<h1 class="mt-1 text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">
			Import Assays from JSON
		</h1>
		<p class="mt-1 text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
			Upload a JSON file containing assay definitions in CouchDB format. Supports single or batch
			import.
		</p>
	</div>

	<!-- File Upload Form -->
	{#if !previews.length && !importResult}
		<form
			method="POST"
			action="?/preview"
			enctype="multipart/form-data"
			use:enhance={() => {
				return async ({ update }) => {
					await update();
				};
			}}
		>
			<div class="tron-card space-y-4 p-6">
				<div>
					<label
						for="file-input"
						class="mb-2 block text-sm font-medium"
						style="color: var(--color-tron-text-primary, #e5e7eb)"
					>
						JSON File
					</label>
					<input
						id="file-input"
						name="file"
						type="file"
						accept=".json"
						required
						class="tron-input w-full"
						style="min-height: 44px; padding: 8px"
					/>
					<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">
						Accepts .json files with CouchDB assay format: {'{ assayName, BCODE: { code: [...] } }'}
					</p>
				</div>

				{#if error}
					<div
						class="rounded p-3 text-sm"
						style="background: rgba(239, 68, 68, 0.1); color: #ef4444"
					>
						{error}
					</div>
				{/if}

				<button
					type="submit"
					class="tron-button w-full"
					style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000; font-weight: 600"
				>
					Parse & Preview
				</button>
			</div>
		</form>
	{/if}

	<!-- Preview & Confirm -->
	{#if previews.length > 0 && !importResult}
		<ImportPreview {previews} {selected} onToggle={toggleSelection} onToggleAll={toggleAll} />

		<form
			method="POST"
			action="?/import"
			use:enhance={() => {
				importing = true;
				return async ({ update }) => {
					importing = false;
					await update();
				};
			}}
		>
			<input type="hidden" name="rawJson" value={form?.rawJson ?? ''} />
			{#each [...selected] as idx}
				<input type="hidden" name="selected" value={idx} />
			{/each}

			<div class="flex gap-3">
				<a
					href="/assays/import"
					class="tron-button flex-1 text-center"
					style="min-height: 44px"
				>
					Start Over
				</a>
				<button
					type="submit"
					disabled={selected.size === 0 || importing}
					class="tron-button flex-1"
					style="min-height: 44px; background: var(--color-tron-green, #39ff14); color: #000; font-weight: 600"
				>
					{importing
						? 'Importing...'
						: `Import ${selected.size} Assay${selected.size !== 1 ? 's' : ''}`}
				</button>
			</div>
		</form>
	{/if}

	<!-- Import Result -->
	{#if importResult}
		<div class="tron-card space-y-4 p-6">
			<h2 class="text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
				Import Complete
			</h2>

			<div class="grid gap-4 sm:grid-cols-2">
				<div class="rounded p-3" style="background: rgba(57, 255, 20, 0.1)">
					<div class="text-2xl font-bold" style="color: var(--color-tron-green, #39ff14)">
						{importResult.imported}
					</div>
					<div class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
						Imported
					</div>
				</div>
				{#if importResult.skipped > 0}
					<div class="rounded p-3" style="background: rgba(239, 68, 68, 0.1)">
						<div class="text-2xl font-bold" style="color: #ef4444">
							{importResult.skipped}
						</div>
						<div class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
							Skipped
						</div>
					</div>
				{/if}
			</div>

			{#if importResult.errors.length > 0}
				<div class="space-y-1">
					<span class="text-sm font-medium" style="color: #ef4444">Errors:</span>
					{#each importResult.errors as err}
						<div class="text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">
							{err}
						</div>
					{/each}
				</div>
			{/if}

			<div class="flex gap-3">
				<a
					href="/assays/import"
					class="tron-button flex-1 text-center"
					style="min-height: 44px"
				>
					Import More
				</a>
				<a
					href="/assays"
					class="tron-button flex-1 text-center"
					style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000; font-weight: 600"
				>
					View Assays
				</a>
			</div>
		</div>
	{/if}
</div>
