<script lang="ts">
	let { data } = $props();

	let filterCategory = $state('All');
	let sortDir = $state<'asc' | 'desc'>('asc');

	// Import modal
	let showImport = $state(false);
	let importFile = $state<File | null>(null);
	let importing = $state(false);
	let importError = $state('');
	let busyKey = $state(''); // namespace/loadName/version currently deleting

	const categories = $derived(() => {
		const cats = new Set(data.labware.map((lw: any) => lw.category));
		return ['All', ...Array.from(cats).sort()];
	});

	const filteredLabware = $derived(() => {
		let list = data.labware as any[];
		if (filterCategory !== 'All') list = list.filter((lw) => lw.category === filterCategory);
		return [...list].sort((a, b) => {
			const cmp = a.displayName.localeCompare(b.displayName);
			return sortDir === 'asc' ? cmp : -cmp;
		});
	});

	async function handleImport() {
		if (!importFile || importing) return;
		importing = true;
		importError = '';
		try {
			const fd = new FormData();
			fd.append('labwareFile', importFile);
			const res = await fetch('/api/opentrons-lab/labware', { method: 'POST', body: fd });
			if (!res.ok) {
				const b = await res.json().catch(() => ({}));
				throw new Error(b.message || `Upload failed (HTTP ${res.status})`);
			}
			showImport = false;
			importFile = null;
			window.location.reload();
		} catch (e) {
			importError = e instanceof Error ? e.message : 'Upload failed';
		} finally {
			importing = false;
		}
	}

	async function handleDelete(lw: any) {
		if (!confirm(`Remove labware "${lw.displayName}" (${lw.loadName} v${lw.version}) from the library? It will no longer be bundled with future protocol uploads.`)) return;
		busyKey = `${lw.namespace}/${lw.loadName}/${lw.version}`;
		try {
			const q = new URLSearchParams({ namespace: lw.namespace, loadName: lw.loadName, version: String(lw.version) });
			const res = await fetch(`/api/opentrons-lab/labware?${q}`, { method: 'DELETE' });
			if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
			window.location.reload();
		} catch (e) {
			alert(e instanceof Error ? e.message : 'Delete failed');
		} finally {
			busyKey = '';
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">Labware</h1>
			<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				Custom labware library — bundled with every protocol upload so robots resolve it.
			</p>
		</div>
		<button
			onclick={() => { showImport = true; importError = ''; }}
			class="rounded-md border border-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)] hover:text-black"
		>
			Import labware
		</button>
	</div>

	<!-- Filters -->
	<div class="flex items-center gap-4">
		<div class="flex items-center gap-2 text-sm">
			<span class="text-[var(--color-tron-text-secondary)]">Category</span>
			<select bind:value={filterCategory} class="tron-input px-2 py-1 text-sm">
				{#each categories() as cat (cat)}
					<option value={cat}>{cat}</option>
				{/each}
			</select>
		</div>
		<div class="flex items-center gap-2 text-sm">
			<span class="text-[var(--color-tron-text-secondary)]">Sort</span>
			<select bind:value={sortDir} class="tron-input px-2 py-1 text-sm">
				<option value="asc">A–Z</option>
				<option value="desc">Z–A</option>
			</select>
		</div>
		<span class="text-xs text-[var(--color-tron-text-secondary)]">
			{filteredLabware().length} item{filteredLabware().length === 1 ? '' : 's'}
		</span>
	</div>

	<!-- Labware list -->
	{#if filteredLabware().length === 0}
		<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-tron-border)] py-16">
			<svg class="mb-4 h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
			</svg>
			<p class="mb-2 text-lg font-medium text-[var(--color-tron-text)]">No labware in the library</p>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">Import a labware definition (.json) to get started.</p>
		</div>
	{:else}
		<div class="space-y-2">
			{#each filteredLabware() as lw (lw.id)}
				<div class="flex items-center gap-4 rounded-lg border border-[var(--color-tron-border)] p-3">
					<div class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-[var(--color-tron-bg-secondary)]">
						<svg class="h-5 w-5 text-[var(--color-tron-text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
						</svg>
					</div>
					<div class="flex-1 min-w-0">
						<h3 class="truncate text-sm font-medium text-[var(--color-tron-text)]">{lw.displayName}</h3>
						<span class="font-mono text-xs text-[var(--color-tron-text-secondary)]">{lw.namespace}/{lw.loadName} · v{lw.version}</span>
					</div>
					<span class="rounded bg-[var(--color-tron-bg-secondary)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">{lw.category}</span>
					<span class="hidden text-xs text-[var(--color-tron-text-secondary)] sm:inline">
						{lw.usedIn > 0 ? `used in ${lw.usedIn} protocol${lw.usedIn === 1 ? '' : 's'}` : 'unused'}
					</span>
					<button
						onclick={() => handleDelete(lw)}
						disabled={busyKey === `${lw.namespace}/${lw.loadName}/${lw.version}`}
						class="rounded border border-red-500/40 px-2.5 py-1 text-xs text-red-300 transition-colors hover:bg-red-900/30 disabled:opacity-40"
					>
						Remove
					</button>
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Import modal -->
{#if showImport}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onclick={() => { showImport = false; }}>
		<div class="w-full max-w-md rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-6" onclick={(e) => e.stopPropagation()}>
			<h2 class="mb-1 text-lg font-bold text-[var(--color-tron-text)]">Import labware</h2>
			<p class="mb-4 text-xs text-[var(--color-tron-text-secondary)]">
				Upload an Opentrons labware definition (.json). It joins the library and is bundled with every future protocol upload.
			</p>
			<div class="space-y-4">
				<div>
					<label class="mb-1 block text-sm text-[var(--color-tron-text-secondary)]" for="labware-file">Labware definition (.json)</label>
					<input
						id="labware-file"
						type="file"
						accept=".json"
						class="tron-input w-full px-3 py-2 text-sm"
						onchange={(e) => { importFile = (e.target as HTMLInputElement).files?.[0] ?? null; }}
					/>
				</div>
				{#if importError}<p class="text-sm text-[var(--color-tron-error)]">{importError}</p>{/if}
				<div class="flex justify-end gap-3">
					<button onclick={() => { showImport = false; }} class="rounded px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Cancel</button>
					<button
						onclick={handleImport}
						disabled={!importFile || importing}
						class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black transition-opacity disabled:opacity-50"
					>
						{importing ? 'Uploading…' : 'Import'}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
