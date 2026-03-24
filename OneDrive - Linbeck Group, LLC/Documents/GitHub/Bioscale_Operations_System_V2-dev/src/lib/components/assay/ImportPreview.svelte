<script lang="ts">
	interface AssayPreview {
		name: string;
		instructionCount: number;
		bcode: string | null;
		bcodeLength: number;
		checksum: number;
		existingId: string | null;
		valid: boolean;
		error: string | null;
	}

	interface Props {
		previews: AssayPreview[];
		selected: Set<number>;
		onToggle: (index: number) => void;
		onToggleAll: () => void;
	}

	let { previews, selected, onToggle, onToggleAll }: Props = $props();

	const validCount = $derived(previews.filter((p) => p.valid).length);
	const allValidSelected = $derived(previews.every((p, i) => !p.valid || selected.has(i)));
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between">
		<span class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
			{previews.length} assay{previews.length !== 1 ? 's' : ''} found ({validCount} valid)
		</span>
		{#if validCount > 1}
			<button
				type="button"
				class="tron-button text-xs"
				style="min-height: 36px"
				onclick={onToggleAll}
			>
				{allValidSelected ? 'Deselect All' : 'Select All Valid'}
			</button>
		{/if}
	</div>

	{#each previews as preview, index (index)}
		<div
			class="tron-card p-4"
			style="border-left: 3px solid {preview.valid
				? preview.existingId
					? '#f97316'
					: 'var(--color-tron-green, #39ff14)'
				: '#ef4444'}"
		>
			<div class="flex items-start gap-3">
				{#if preview.valid}
					<input
						type="checkbox"
						name="selected"
						value={index}
						checked={selected.has(index)}
						onchange={() => onToggle(index)}
						class="mt-1"
						style="min-width: 20px; min-height: 20px; accent-color: var(--color-tron-cyan, #00ffff)"
					/>
				{:else}
					<div class="mt-1 h-5 w-5 text-center text-xs" style="color: #ef4444">X</div>
				{/if}

				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<span class="font-medium" style="color: var(--color-tron-text-primary, #e5e7eb)">
							{preview.name}
						</span>
						{#if preview.existingId}
							<span
								class="rounded px-1.5 py-0.5 text-xs"
								style="background: rgba(249, 115, 22, 0.15); color: #f97316"
							>
								Exists: {preview.existingId}
							</span>
						{/if}
					</div>

					{#if preview.valid}
						<div
							class="mt-1 flex flex-wrap gap-4 text-xs"
							style="color: var(--color-tron-text-secondary, #9ca3af)"
						>
							<span>{preview.instructionCount} instructions</span>
							<span>{preview.bcodeLength} bytes</span>
							<span>CRC32: {preview.checksum}</span>
						</div>
						{#if preview.bcode}
							<pre
								class="mt-2 max-h-24 overflow-auto rounded p-2 font-mono text-xs"
								style="background: var(--color-tron-bg-tertiary, #1e1e2e); color: var(--color-tron-text-secondary, #9ca3af)">{preview.bcode}</pre>
						{/if}
					{:else}
						<div class="mt-1 text-xs" style="color: #ef4444">
							{preview.error}
						</div>
					{/if}
				</div>
			</div>
		</div>
	{/each}
</div>
