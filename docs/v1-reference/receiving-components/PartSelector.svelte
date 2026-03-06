<script lang="ts">
	interface Part {
		id: string;
		partNumber: string;
		name: string;
		category: string | null;
		manufacturer: string | null;
		inspectionPathway: string;
		sampleSize: number;
		percentAccepted: number;
	}

	interface Props {
		parts: Part[];
		onselect: (part: Part) => void;
		selected?: Part | null;
	}

	let { parts, onselect, selected = null }: Props = $props();

	let search = $state('');
	let open = $state(false);

	const filtered = $derived(
		search.trim()
			? parts.filter((p) => {
					const q = search.toLowerCase();
					return (
						p.partNumber.toLowerCase().includes(q) ||
						p.name.toLowerCase().includes(q) ||
						(p.manufacturer?.toLowerCase().includes(q) ?? false)
					);
				})
			: parts
	);

	function select(part: Part) {
		open = false;
		search = '';
		onselect(part);
	}
</script>

<div class="relative">
	{#if selected}
		<div class="tron-card flex items-center justify-between p-3">
			<div>
				<span class="tron-text font-mono text-sm font-medium">{selected.partNumber}</span>
				<span class="tron-text-muted mx-1">—</span>
				<span class="tron-text text-sm">{selected.name}</span>
				{#if selected.category}
					<span class="tron-text-muted ml-2 text-xs">({selected.category})</span>
				{/if}
				<span class="ml-2 rounded px-2 py-0.5 text-xs font-medium uppercase {selected.inspectionPathway === 'coc' ? 'bg-blue-500/20 text-blue-400' : 'bg-orange-500/20 text-orange-400'}">
					{selected.inspectionPathway}
				</span>
			</div>
			<button
				type="button"
				class="tron-text-muted text-xs hover:underline"
				onclick={() => onselect(null as unknown as Part)}
			>
				Change
			</button>
		</div>
	{:else}
		<div class="relative">
			<input
				type="text"
				bind:value={search}
				onfocus={() => (open = true)}
				placeholder="Search by part #, name, or manufacturer..."
				class="tron-input w-full px-3 py-2 text-sm"
			/>
			{#if open}
				<div class="tron-card absolute z-50 mt-1 max-h-64 w-full overflow-y-auto shadow-lg">
					{#if filtered.length === 0}
						<div class="tron-text-muted p-3 text-sm">No matching parts</div>
					{:else}
						{#each filtered as part}
							<button
								type="button"
								class="hover:bg-white/5 w-full px-3 py-2 text-left text-sm"
								onclick={() => select(part)}
							>
								<span class="tron-text font-mono font-medium">{part.partNumber}</span>
								<span class="tron-text-muted mx-1">—</span>
								<span class="tron-text">{part.name}</span>
								{#if part.manufacturer}
									<span class="tron-text-muted ml-1 text-xs">({part.manufacturer})</span>
								{/if}
								<span class="ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase {part.inspectionPathway === 'coc' ? 'bg-blue-500/20 text-blue-400' : 'bg-orange-500/20 text-orange-400'}">
									{part.inspectionPathway}
								</span>
							</button>
						{/each}
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>
