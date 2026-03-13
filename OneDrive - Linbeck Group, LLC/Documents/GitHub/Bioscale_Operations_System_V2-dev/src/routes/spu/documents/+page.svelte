<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';

	let { data, form } = $props();

	let isDragging = $state(false);
	let showUploadModal = $state(false);
	let selectedFile = $state<File | null>(null);
	let selectedFileType = $state('document');
	let description = $state('');
	let replaceExisting = $state(false);
	let existingFileId = $state('');
	let uploading = $state(false);

	const fileTypes = [
		{ value: 'document', label: 'Document' },
		{ value: 'image', label: 'Drawing/Image' },
		{ value: 'spreadsheet', label: 'Spreadsheet' },
		{ value: 'raw_data', label: 'Raw Data' },
		{ value: 'other', label: 'Other' }
	];

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		isDragging = true;
	}

	function handleDragLeave(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDragging = false;

		const files = e.dataTransfer?.files;
		if (files && files.length > 0) {
			selectedFile = files[0];
			detectFileType(selectedFile);
			showUploadModal = true;
		}
	}

	function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files && input.files.length > 0) {
			selectedFile = input.files[0];
			detectFileType(selectedFile);
			showUploadModal = true;
		}
	}

	function detectFileType(file: File) {
		const ext = file.name.split('.').pop()?.toLowerCase() || '';
		const mimeType = file.type.toLowerCase();

		// Detect based on extension and MIME type
		if (['pdf', 'doc', 'docx', 'txt', 'rtf'].includes(ext) || mimeType.includes('document')) {
			selectedFileType = 'document';
		} else if (
			['jpg', 'jpeg', 'png', 'gif', 'svg', 'dwg', 'dxf'].includes(ext) ||
			mimeType.startsWith('image/')
		) {
			selectedFileType = 'image';
		} else if (['xls', 'xlsx', 'csv'].includes(ext) || mimeType.includes('spreadsheet')) {
			selectedFileType = 'spreadsheet';
		} else if (['json', 'xml', 'dat'].includes(ext)) {
			selectedFileType = 'raw_data';
		} else {
			selectedFileType = 'other';
		}
	}

	function formatFileSize(bytes: number | null): string {
		if (!bytes) return '—';
		if (bytes < 1024) return bytes + ' B';
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
		return (bytes / 1024 / 1024).toFixed(1) + ' MB';
	}

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString();
	}

	function getFileTypeLabel(type: string | null): string {
		const typeMap: Record<string, string> = {
			document: 'Document',
			image: 'Drawing',
			spreadsheet: 'Spreadsheet',
			raw_data: 'Raw Data',
			other: 'Other'
		};
		return typeMap[type || 'other'] || 'Other';
	}

	function getFileTypeBadgeVariant(type: string | null): 'success' | 'warning' | 'neutral' {
		if (type === 'document') return 'success';
		if (type === 'image') return 'warning';
		return 'neutral';
	}

	function closeModal() {
		showUploadModal = false;
		selectedFile = null;
		description = '';
		replaceExisting = false;
		existingFileId = '';
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary text-2xl font-bold">Document Management</h2>
			<p class="tron-text-muted">Upload and manage drawings, work instructions, and documents</p>
		</div>
	</div>

	<!-- Drag and Drop Upload Area -->
	<TronCard>
		<div
			class="relative rounded-lg border-2 border-dashed p-8 text-center transition-all duration-200
				{isDragging
				? 'border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.05)]'
				: 'border-[var(--color-tron-border)] hover:border-[var(--color-tron-cyan)]'}"
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
			ondrop={handleDrop}
			role="button"
			tabindex="0"
		>
			<input
				type="file"
				class="absolute inset-0 cursor-pointer opacity-0"
				onchange={handleFileSelect}
				accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.jpg,.jpeg,.png,.gif,.svg,.dwg,.txt"
			/>
			<div class="pointer-events-none">
				<svg
					class="mx-auto mb-4 h-12 w-12 {isDragging
						? 'text-[var(--color-tron-cyan)]'
						: 'text-[var(--color-tron-text-secondary)]'}"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="1.5"
						d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
					/>
				</svg>
				<p class="tron-text-primary mb-2 text-lg font-medium">
					{isDragging ? 'Drop file here' : 'Drag and drop a file here'}
				</p>
				<p class="tron-text-muted text-sm">or click to browse</p>
				<p class="tron-text-muted mt-2 text-xs">
					Supported: PDF, DOC, XLS, Images, Drawings (max 50MB)
				</p>
			</div>
		</div>
	</TronCard>

	<!-- Files Table -->
	<TronCard>
		<div class="mb-4 flex items-center justify-between">
			<h3 class="tron-text-primary text-lg font-medium">Uploaded Documents</h3>
			<span class="tron-text-muted text-sm">{data.files.length} files</span>
		</div>
		<div class="overflow-x-auto">
			<table class="tron-table">
				<thead>
					<tr>
						<th>Filename</th>
						<th>Type</th>
						<th>Size</th>
						<th>Version</th>
						<th>Uploaded</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each data.files as file}
						<tr>
							<td>
								<div class="flex items-center gap-2">
									<svg
										class="h-5 w-5 text-[var(--color-tron-cyan)]"
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
									<span class="font-medium">{file.filename}</span>
								</div>
							</td>
							<td>
								<TronBadge variant={getFileTypeBadgeVariant(file.fileType)}>
									{getFileTypeLabel(file.fileType)}
								</TronBadge>
							</td>
							<td class="font-mono text-sm">{formatFileSize(file.fileSize)}</td>
							<td class="text-center">
								<span
									class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-1 font-mono text-sm"
								>
									v{file.version}
								</span>
								{#if file.isLatest}
									<TronBadge variant="success">Latest</TronBadge>
								{/if}
							</td>
							<td class="text-sm">{formatDate(file.uploadedAt)}</td>
							<td>
								<div class="flex gap-2">
									<button
										type="button"
										class="text-sm text-[var(--color-tron-cyan)] hover:underline"
										onclick={() => {
											replaceExisting = true;
											existingFileId = file.id;
											showUploadModal = true;
										}}
									>
										Replace
									</button>
									<form method="POST" action="?/delete" use:enhance class="inline">
										<input type="hidden" name="fileId" value={file.id} />
										<button
											type="submit"
											class="text-sm text-[var(--color-tron-red)] hover:underline"
										>
											Delete
										</button>
									</form>
								</div>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="6" class="py-8 text-center tron-text-muted">
								No documents uploaded yet. Drag and drop a file above to get started.
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</TronCard>
</div>

<!-- Upload Modal -->
{#if showUploadModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
		<div class="w-full max-w-md">
			<TronCard>
				<div class="mb-6 flex items-center justify-between">
					<h3 class="tron-text-primary text-xl font-bold">
						{replaceExisting ? 'Replace Document' : 'Upload Document'}
					</h3>
					<button
						type="button"
						class="tron-text-muted hover:tron-text-primary"
						onclick={closeModal}
						aria-label="Close modal"
					>
						<svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				</div>

				<form
					method="POST"
					action="?/upload"
					enctype="multipart/form-data"
					use:enhance={() => {
						uploading = true;
						return async ({ result, update }) => {
							uploading = false;
							await update();
							if (result.type === 'success') {
								closeModal();
							}
						};
					}}
					class="space-y-4"
				>
					<div
						class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-4"
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
							<div class="flex-1">
								{#if selectedFile}
									<p class="tron-text-primary font-medium">{selectedFile.name}</p>
									<p class="tron-text-muted text-sm">{formatFileSize(selectedFile.size)}</p>
								{:else}
									<p class="tron-text-muted">No file selected</p>
								{/if}
							</div>
							<label class="cursor-pointer">
								<span class="text-sm text-[var(--color-tron-cyan)] hover:underline">Change</span>
								<input
									type="file"
									name="file"
									class="hidden"
									accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.jpg,.jpeg,.png,.gif,.svg,.dwg,.txt"
									onchange={(e) => {
										const input = e.target as HTMLInputElement;
										if (input.files && input.files.length > 0) {
											selectedFile = input.files[0];
											detectFileType(selectedFile);
										}
									}}
								/>
							</label>
						</div>
					</div>

					<div>
						<label for="fileType" class="tron-label">Document Type</label>
						<select
							id="fileType"
							name="fileType"
							class="tron-select"
							bind:value={selectedFileType}
							disabled={uploading}
						>
							{#each fileTypes as type}
								<option value={type.value}>{type.label}</option>
							{/each}
						</select>
						<p class="tron-text-muted mt-1 text-xs">
							Auto-detected based on file extension. Change if needed.
						</p>
					</div>

					<div>
						<label for="description" class="tron-label">Description (Optional)</label>
						<textarea
							id="description"
							name="description"
							class="tron-input"
							rows="2"
							placeholder="Brief description of the document..."
							bind:value={description}
							disabled={uploading}
						></textarea>
					</div>

					{#if replaceExisting}
						<div
							class="rounded-lg border border-[var(--color-tron-yellow)] bg-[rgba(255,206,72,0.1)] p-3"
						>
							<div class="flex items-start gap-2">
								<svg
									class="h-5 w-5 shrink-0 text-[var(--color-tron-yellow)]"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
									/>
								</svg>
								<div>
									<p class="text-sm font-medium text-[var(--color-tron-yellow)]">Version Update</p>
									<p class="tron-text-muted text-sm">
										This will create a new version and mark the previous as outdated.
									</p>
								</div>
							</div>
						</div>
						<input type="hidden" name="replaceExisting" value="true" />
						<input type="hidden" name="existingFileId" value={existingFileId} />
					{/if}

					{#if form?.error}
						<div
							class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3"
						>
							<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
						</div>
					{/if}

					<div class="flex gap-3 pt-2">
						<TronButton type="button" class="flex-1" onclick={closeModal} disabled={uploading}>
							Cancel
						</TronButton>
						<TronButton type="submit" variant="primary" class="flex-1" disabled={uploading}>
							{#if uploading}
								Uploading...
							{:else}
								{replaceExisting ? 'Replace & Upload' : 'Upload'}
							{/if}
						</TronButton>
					</div>
				</form>
			</TronCard>
		</div>
	</div>
{/if}
