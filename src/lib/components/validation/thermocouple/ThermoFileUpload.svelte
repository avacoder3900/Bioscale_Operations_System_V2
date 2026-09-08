<script lang="ts">
	/**
	 * Thermocouple file picker.
	 *
	 * Deliberately dumb: it stages the operator's file on a real form input and
	 * reports the choice upward. It does not parse. The file itself is what gets
	 * posted, so there is no parsed copy of the data that can drift away from the
	 * file on screen — the defect that recorded SPU 247's measurement on SPU 257.
	 */
	interface Props {
		accept?: string;
		compact?: boolean;
		/** Form field name the file is posted under. */
		name?: string;
		onfile?: (file: File | null) => void;
	}

	let { accept = '.csv,.xlsx', compact = false, name = 'file', onfile }: Props = $props();

	let fileName = $state('');
	let fileSize = $state(0);
	let isDragging = $state(false);
	let inputEl = $state<HTMLInputElement | undefined>();

	let hasFile = $derived(fileName !== '');

	function announce(file: File | null) {
		fileName = file?.name ?? '';
		fileSize = file?.size ?? 0;
		onfile?.(file);
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
		const file = e.dataTransfer?.files?.[0];
		if (!file || !inputEl) return;
		// Move the dropped file onto the real input so the form posts it.
		const dt = new DataTransfer();
		dt.items.add(file);
		inputEl.files = dt.files;
		announce(file);
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		isDragging = true;
	}

	function handleFileInput(e: Event) {
		announce((e.target as HTMLInputElement).files?.[0] ?? null);
	}

	function clearFile() {
		if (inputEl) inputEl.value = '';
		announce(null);
	}

	function fmtSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<!-- Lives outside the branches below so the staged file survives the swap. -->
<input bind:this={inputEl} type="file" {name} {accept} class="hidden" onchange={handleFileInput} />

{#if !hasFile}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="flex flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors
			{compact ? 'p-4' : 'p-12'}
			{isDragging
				? 'border-[var(--color-tron-orange)] bg-[var(--color-tron-orange)]/10'
				: 'border-[var(--color-tron-border)] hover:border-[var(--color-tron-cyan)]'}"
		ondrop={handleDrop}
		ondragover={handleDragOver}
		ondragleave={() => isDragging = false}
	>
		{#if !compact}
			<svg class="mb-4 h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
			</svg>
		{/if}
		<p class="tron-heading mb-2 {compact ? 'text-sm' : 'text-lg'}">Drop .csv or .xlsx file here</p>
		<p class="tron-text-muted mb-4 text-sm">or click to browse</p>
		<button
			type="button"
			onclick={() => inputEl?.click()}
			class="cursor-pointer rounded-lg bg-[var(--color-tron-orange)] font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 {compact ? 'px-4 py-2 text-sm' : 'px-6 py-3'}"
			style="min-height: {compact ? '36px' : '44px'}"
		>
			Choose File
		</button>
	</div>
{:else}
	<!-- File staged. Readings are counted by the server, after it reads the file. -->
	<div class="flex items-center justify-between rounded-lg bg-[var(--color-tron-bg-tertiary)] {compact ? 'p-3' : 'p-4'}">
		<div class="flex items-center gap-3">
			<svg class="{compact ? 'h-6 w-6' : 'h-8 w-8'} text-[var(--color-tron-green)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
			<div>
				<p class="tron-heading font-medium {compact ? 'text-sm' : ''}">{fileName}</p>
				<p class="tron-text-muted text-sm">{fmtSize(fileSize)} · ready to upload</p>
			</div>
		</div>
		<button type="button" onclick={clearFile} class="tron-text-muted text-sm hover:text-[var(--color-tron-red)]">
			Clear
		</button>
	</div>
{/if}
