<script lang="ts">
	interface Props {
		accept?: string;
		maxSize?: number;
		onFile: (file: File) => void;
		class?: string;
	}

	let { accept = '*', maxSize = 10 * 1024 * 1024, onFile, class: className = '' }: Props = $props();

	let isDragging = $state(false);
	let error = $state<string | null>(null);
	let fileInputEl: HTMLInputElement;

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function getAcceptedExtensions(): string[] {
		if (accept === '*') return [];
		return accept.split(',').map((ext) => ext.trim().toLowerCase());
	}

	function validateFile(file: File): string | null {
		const extensions = getAcceptedExtensions();
		if (extensions.length > 0) {
			const fileName = file.name.toLowerCase();
			const hasValidExtension = extensions.some((ext) => fileName.endsWith(ext));
			if (!hasValidExtension) {
				return `Invalid file type. Accepted: ${extensions.join(', ')}`;
			}
		}

		if (file.size > maxSize) {
			return `File too large. Maximum size: ${formatSize(maxSize)}`;
		}

		return null;
	}

	function handleFile(file: File) {
		error = null;
		const validationError = validateFile(file);
		if (validationError) {
			error = validationError;
			return;
		}
		onFile(file);
	}

	function handleDrop(event: DragEvent) {
		event.preventDefault();
		isDragging = false;

		const file = event.dataTransfer?.files[0];
		if (file) {
			handleFile(file);
		}
	}

	function handleDragOver(event: DragEvent) {
		event.preventDefault();
		isDragging = true;
	}

	function handleDragLeave() {
		isDragging = false;
	}

	function handleClick() {
		fileInputEl?.click();
	}

	function handleInputChange(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) {
			handleFile(file);
		}
		input.value = '';
	}
</script>

<div class={className}>
	<button
		type="button"
		class="dropzone"
		class:dragging={isDragging}
		class:has-error={error}
		ondrop={handleDrop}
		ondragover={handleDragOver}
		ondragleave={handleDragLeave}
		onclick={handleClick}
	>
		<input
			bind:this={fileInputEl}
			type="file"
			{accept}
			class="hidden"
			onchange={handleInputChange}
		/>

		<svg class="icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width="2"
				d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
			/>
		</svg>

		<p class="text-primary">
			{#if isDragging}
				Drop file here
			{:else}
				Drag & drop a file or <span class="text-cyan">click to browse</span>
			{/if}
		</p>

		<p class="text-secondary">
			{#if accept !== '*'}
				Accepted: {accept}
			{/if}
			{#if maxSize}
				{accept !== '*' ? ' | ' : ''}Max size: {formatSize(maxSize)}
			{/if}
		</p>
	</button>

	{#if error}
		<p class="error-message">{error}</p>
	{/if}
</div>

<style>
	.dropzone {
		width: 100%;
		padding: 2rem;
		border: 2px dashed var(--color-tron-border);
		border-radius: 0.5rem;
		background: var(--color-tron-bg-secondary);
		cursor: pointer;
		transition: all 0.2s ease;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
	}

	.dropzone:hover {
		border-color: var(--color-tron-cyan);
		background: var(--color-tron-bg-tertiary);
	}

	.dropzone.dragging {
		border-color: var(--color-tron-cyan);
		background: var(--color-tron-bg-tertiary);
		box-shadow: 0 0 20px rgba(0, 255, 255, 0.2);
	}

	.dropzone.has-error {
		border-color: var(--color-tron-red);
	}

	.icon {
		width: 3rem;
		height: 3rem;
		color: var(--color-tron-text-secondary);
	}

	.dragging .icon {
		color: var(--color-tron-cyan);
	}

	.text-primary {
		font-size: 0.875rem;
		color: var(--color-tron-text-primary);
	}

	.text-secondary {
		font-size: 0.75rem;
		color: var(--color-tron-text-secondary);
	}

	.text-cyan {
		color: var(--color-tron-cyan);
	}

	.error-message {
		margin-top: 0.5rem;
		font-size: 0.875rem;
		color: var(--color-tron-red);
	}
</style>
