<script lang="ts">
	import { enhance } from '$app/forms';
	import { FileDropzone } from '$lib/components/upload';

	interface Props {
		data: {
			canUploadWorkInstruction: boolean;
			canUploadDocument: boolean;
		};
		form: {
			success?: boolean;
			error?: string;
			type?: 'work_instruction' | 'document';
			workInstructionId?: string;
			documentId?: string;
			existingId?: string;
			parsed?: {
				steps?: Array<{
					stepNumber: number;
					title: string;
					description: string;
					partRequirements?: Array<{
						partNumber: string;
						quantity: number;
						partDefinitionId?: string;
					}>;
				}>;
				partsFound?: string[];
				toolsFound?: string[];
				docType?: string;
				documentNumber?: string;
				title?: string;
				fileName?: string;
				textPreview?: string;
				// PRD-INVWI: Aggregated part requirements across all steps
				totalPartRequirements?: Array<{
					partNumber: string;
					quantity: number;
					partDefinitionId?: string;
					linkedPartName?: string;
				}>;
			};
		} | null;
	}

	let { data, form }: Props = $props();

	let selectedFile = $state<File | null>(null);
	let uploading = $state(false);
	let title = $state('');
	let description = $state('');

	function handleFile(file: File) {
		selectedFile = file;
	}

	function clearFile() {
		selectedFile = null;
		title = '';
		description = '';
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<svelte:head>
	<title>Upload Document | SPU Documents</title>
</svelte:head>

<div class="space-y-6">
	<div>
		<h1 class="tron-heading text-2xl font-bold">Upload Document</h1>
		<p class="tron-text-muted mt-1">
			Upload work instructions (PDF/DOCX) to automatically parse and import them.
		</p>
	</div>

	{#if form?.success}
		<div class="tron-card border-[var(--color-tron-green)] bg-[var(--color-tron-green)]/10 p-4">
			<div class="flex items-start gap-3">
				<svg
					class="h-5 w-5 text-[var(--color-tron-green)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M5 13l4 4L19 7"
					/>
				</svg>
				<div>
					<p class="font-medium text-[var(--color-tron-green)]">Upload successful!</p>
					{#if form.type === 'work_instruction'}
						<p class="tron-text-muted mt-1 text-sm">
							Work instruction "{form.parsed?.title || form.parsed?.documentNumber}" has been
							created with {form.parsed?.steps?.length || 0} steps.
						</p>
						<a
							href="/documents/instructions/{form.workInstructionId}"
							class="mt-2 inline-flex items-center gap-1 text-sm text-[var(--color-tron-cyan)] hover:underline"
						>
							View Work Instruction
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M9 5l7 7-7 7"
								/>
							</svg>
						</a>
					{:else}
						<p class="tron-text-muted mt-1 text-sm">
							Document "{form.parsed?.fileName}" has been added to the repository.
						</p>
						<a
							href="/documents/repository"
							class="mt-2 inline-flex items-center gap-1 text-sm text-[var(--color-tron-cyan)] hover:underline"
						>
							View Repository
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M9 5l7 7-7 7"
								/>
							</svg>
						</a>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	{#if form?.error}
		<div class="tron-card border-[var(--color-tron-red)] bg-[var(--color-tron-red)]/10 p-4">
			<div class="flex items-start gap-3">
				<svg
					class="h-5 w-5 text-[var(--color-tron-red)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
					/>
				</svg>
				<div>
					<p class="font-medium text-[var(--color-tron-red)]">Upload failed</p>
					<p class="tron-text-muted mt-1 text-sm">{form.error}</p>
					{#if form.existingId}
						<a
							href="/documents/instructions/{form.existingId}"
							class="mt-2 inline-flex items-center gap-1 text-sm text-[var(--color-tron-cyan)] hover:underline"
						>
							View existing document
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M9 5l7 7-7 7"
								/>
							</svg>
						</a>
					{/if}
				</div>
			</div>
		</div>

		{#if form.parsed?.steps}
			<div class="tron-card p-4">
				<h3 class="tron-heading mb-3 text-lg font-semibold">Parsed Preview</h3>
				<p class="tron-text-muted mb-4 text-sm">
					Document type: <span class="text-[var(--color-tron-cyan)]">{form.parsed.docType}</span>
					{#if form.parsed.documentNumber}
						| Doc #: <span class="text-[var(--color-tron-cyan)]">{form.parsed.documentNumber}</span>
					{/if}
				</p>

				<div class="space-y-2">
					<h4 class="tron-text-muted text-sm font-medium">
						Steps ({form.parsed.steps.length})
					</h4>
					<ul class="space-y-1 text-sm">
						{#each form.parsed.steps.slice(0, 5) as step}
							<li class="flex gap-2">
								<span class="text-[var(--color-tron-cyan)]">{step.stepNumber}.</span>
								<span class="tron-text-primary">{step.title}</span>
							</li>
						{/each}
						{#if form.parsed.steps.length > 5}
							<li class="tron-text-muted">...and {form.parsed.steps.length - 5} more steps</li>
						{/if}
					</ul>
				</div>

				<!-- PRD-INVWI: Show part requirements with quantities and linkage status -->
				{#if form.parsed.totalPartRequirements && form.parsed.totalPartRequirements.length > 0}
					<div class="mt-4">
						<h4 class="tron-text-muted text-sm font-medium">
							Part Requirements ({form.parsed.totalPartRequirements.length})
						</h4>
						<div class="mt-2 space-y-1">
							{#each form.parsed.totalPartRequirements.slice(0, 10) as part}
								<div class="flex items-center gap-2 text-xs">
									<span class="font-mono text-[var(--color-tron-cyan)]">{part.partNumber}</span>
									<span class="tron-text-muted">×{part.quantity}</span>
									{#if part.partDefinitionId}
										<span
											class="rounded bg-[var(--color-tron-green)]/20 px-1.5 py-0.5 text-[var(--color-tron-green)]"
										>
											✓ Linked{part.linkedPartName ? `: ${part.linkedPartName}` : ''}
										</span>
									{:else}
										<span
											class="rounded bg-[var(--color-tron-orange)]/20 px-1.5 py-0.5 text-[var(--color-tron-orange)]"
										>
											⚠ Not found
										</span>
									{/if}
								</div>
							{/each}
							{#if form.parsed.totalPartRequirements.length > 10}
								<p class="tron-text-muted text-xs">
									+{form.parsed.totalPartRequirements.length - 10} more parts
								</p>
							{/if}
						</div>
					</div>
				{:else if form.parsed.partsFound && form.parsed.partsFound.length > 0}
					<div class="mt-4">
						<h4 class="tron-text-muted text-sm font-medium">
							Parts Found ({form.parsed.partsFound.length})
						</h4>
						<div class="mt-1 flex flex-wrap gap-1">
							{#each form.parsed.partsFound.slice(0, 10) as part}
								<span
									class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]"
								>
									{part}
								</span>
							{/each}
							{#if form.parsed.partsFound.length > 10}
								<span class="tron-text-muted text-xs">
									+{form.parsed.partsFound.length - 10} more
								</span>
							{/if}
						</div>
					</div>
				{/if}
			</div>
		{/if}
	{/if}

	<div class="tron-card p-6">
		<form
			method="POST"
			action="?/upload"
			enctype="multipart/form-data"
			use:enhance={({ formData }) => {
				if (selectedFile) {
					formData.set('file', selectedFile);
				}
				uploading = true;
				return async ({ update }) => {
					await update();
					uploading = false;
					if (!form?.error) {
						selectedFile = null;
						title = '';
						description = '';
					}
				};
			}}
		>
			{#if !selectedFile}
				<FileDropzone accept=".pdf,.docx" maxSize={25 * 1024 * 1024} onFile={handleFile} />
			{:else}
				<div class="space-y-4">
					<div
						class="flex items-center justify-between rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-4"
					>
						<div class="flex items-center gap-3">
							<svg
								class="h-8 w-8 text-[var(--color-tron-cyan)]"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
								/>
							</svg>
							<div>
								<p class="tron-text-primary font-medium">{selectedFile.name}</p>
								<p class="tron-text-muted text-sm">{formatFileSize(selectedFile.size)}</p>
							</div>
						</div>
						<button
							type="button"
							onclick={clearFile}
							aria-label="Remove file"
							class="rounded p-1 text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-bg-secondary)] hover:text-[var(--color-tron-red)]"
						>
							<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M6 18L18 6M6 6l12 12"
								/>
							</svg>
						</button>
					</div>

					<input type="hidden" name="file" />

					<div>
						<label for="title" class="tron-label">Title (optional)</label>
						<input
							type="text"
							id="title"
							name="title"
							bind:value={title}
							class="tron-input"
							placeholder="Auto-generated from document if not provided"
						/>
					</div>

					<div>
						<label for="description" class="tron-label">Description (optional)</label>
						<textarea
							id="description"
							name="description"
							bind:value={description}
							rows="2"
							class="tron-input"
							placeholder="Brief description of the document"
						></textarea>
					</div>

					<div class="flex gap-3">
						<button
							type="submit"
							disabled={uploading}
							class="flex items-center gap-2 rounded-lg bg-[var(--color-tron-green)] px-4 py-2 font-medium text-black transition-all hover:brightness-110 disabled:opacity-50"
						>
							{#if uploading}
								<svg class="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
									<circle
										class="opacity-25"
										cx="12"
										cy="12"
										r="10"
										stroke="currentColor"
										stroke-width="4"
									></circle>
									<path
										class="opacity-75"
										fill="currentColor"
										d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
									></path>
								</svg>
								Processing...
							{:else}
								<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
									/>
								</svg>
								Upload & Process
							{/if}
						</button>
						<button type="button" onclick={clearFile} class="tron-btn-secondary"> Cancel </button>
					</div>
				</div>
			{/if}
		</form>
	</div>

	<div class="tron-card p-4">
		<h3 class="tron-heading mb-2 text-sm font-semibold">Supported File Types</h3>
		<div class="grid gap-4 sm:grid-cols-2">
			<div class="flex items-start gap-3">
				<div
					class="flex h-8 w-8 items-center justify-center rounded bg-[var(--color-tron-bg-tertiary)]"
				>
					<span class="text-xs font-bold text-[var(--color-tron-red)]">PDF</span>
				</div>
				<div>
					<p class="tron-text-primary text-sm font-medium">PDF Documents</p>
					<p class="tron-text-muted text-xs">Work instructions, SOPs, manuals</p>
				</div>
			</div>
			<div class="flex items-start gap-3">
				<div
					class="flex h-8 w-8 items-center justify-center rounded bg-[var(--color-tron-bg-tertiary)]"
				>
					<span class="text-xs font-bold text-[var(--color-tron-cyan)]">DOCX</span>
				</div>
				<div>
					<p class="tron-text-primary text-sm font-medium">Word Documents</p>
					<p class="tron-text-muted text-xs">Editable work instructions</p>
				</div>
			</div>
		</div>
	</div>
</div>
