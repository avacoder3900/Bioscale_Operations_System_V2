<script lang="ts">
	interface Props {
		onupload: (file: File, manualLotNumber?: string) => void;
		uploading?: boolean;
		error?: string | null;
	}

	let { onupload, uploading = false, error = null }: Props = $props();

	let selectedFile = $state<File | null>(null);
	let dragOver = $state(false);
	let previewUrl = $state<string | null>(null);
	let manualLotNumber = $state('');

	const ACCEPTED = '.pdf,.jpg,.jpeg,.png,.heic,.docx';
	const isPdf = $derived(selectedFile?.type === 'application/pdf');
	const isImage = $derived(selectedFile?.type.startsWith('image/') ?? false);

	function handleFiles(files: FileList | null) {
		if (!files?.length) return;
		const file = files[0];
		selectedFile = file;
		if (file.type.startsWith('image/')) {
			previewUrl = URL.createObjectURL(file);
		} else {
			previewUrl = null;
		}
	}

	function handleDrop(e: DragEvent) {
		dragOver = false;
		handleFiles(e.dataTransfer?.files ?? null);
	}

	function handleInput(e: Event) {
		const input = e.target as HTMLInputElement;
		handleFiles(input.files);
	}

	function submit() {
		if (selectedFile) onupload(selectedFile, manualLotNumber.trim() || undefined);
	}
</script>

<div class="space-y-4">
	<!-- Drop zone -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="tron-card cursor-pointer border-2 border-dashed p-8 text-center transition {dragOver ? 'border-cyan-400 bg-cyan-500/10' : 'border-white/10'}"
		ondragover={(e) => { e.preventDefault(); dragOver = true; }}
		ondragleave={() => (dragOver = false)}
		ondrop={(e) => { e.preventDefault(); handleDrop(e); }}
		onclick={() => document.getElementById('coc-file-input')?.click()}
		role="button"
		tabindex="0"
		onkeydown={(e) => { if (e.key === 'Enter') document.getElementById('coc-file-input')?.click(); }}
	>
		<input
			id="coc-file-input"
			type="file"
			accept={ACCEPTED}
			onchange={handleInput}
			class="hidden"
		/>
		{#if selectedFile}
			<p class="tron-text text-sm font-medium">{selectedFile.name}</p>
			<p class="tron-text-muted text-xs">{(selectedFile.size / 1024).toFixed(1)} KB</p>
		{:else}
			<p class="tron-text-muted text-sm">Drag & drop a CoC document here, or click to browse</p>
			<p class="tron-text-muted mt-1 text-xs">PDF, images, or Word documents</p>
		{/if}
	</div>

	<!-- Manual lot number (optional; required if OCR can't read it) -->
	{#if selectedFile}
		<div>
			<label for="coc-lot-number" class="tron-text-muted mb-1 block text-xs">
				Lot Number <span class="tron-text-muted">(optional — will be extracted from COC if left blank)</span>
			</label>
			<input
				id="coc-lot-number"
				type="text"
				bind:value={manualLotNumber}
				placeholder="Enter manually if OCR can't read it"
				class="tron-input w-full px-3 py-2 font-mono text-sm"
			/>
		</div>
	{/if}

	<!-- Error display -->
	{#if error}
		<div class="rounded bg-red-500/10 px-4 py-2 text-sm text-red-400">{error}</div>
	{/if}

	<!-- Preview -->
	{#if selectedFile}
		<div class="tron-card p-4">
			<h3 class="tron-text mb-2 text-xs font-semibold uppercase">Preview</h3>
			{#if isPdf}
				<div class="flex items-center gap-2">
					<svg class="h-6 w-6 text-red-400" fill="currentColor" viewBox="0 0 20 20">
						<path d="M4 18h12a2 2 0 002-2V6l-4-4H4a2 2 0 00-2 2v12a2 2 0 002 2z" />
					</svg>
					<span class="tron-text text-sm">{selectedFile.name}</span>
				</div>
			{:else if isImage && previewUrl}
				<img src={previewUrl} alt="CoC preview" class="max-h-48 rounded" />
			{:else}
				<div class="flex items-center gap-2">
					<svg class="h-6 w-6 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
						<path d="M4 18h12a2 2 0 002-2V6l-4-4H4a2 2 0 00-2 2v12a2 2 0 002 2z" />
					</svg>
					<span class="tron-text text-sm">{selectedFile.name}</span>
					<span class="tron-text-muted text-xs">({(selectedFile.size / 1024).toFixed(1)} KB)</span>
				</div>
			{/if}
		</div>

		<button
			type="button"
			disabled={uploading}
			onclick={submit}
			class="tron-button w-full px-4 py-2 text-sm font-medium disabled:opacity-50"
		>
			{uploading ? 'Uploading...' : 'Accept & Create Lot'}
		</button>
	{/if}
</div>
