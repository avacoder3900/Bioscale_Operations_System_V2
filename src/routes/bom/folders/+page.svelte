<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronButton, TronInput } from '$lib/components/ui';

	let { data, form } = $props();

	let showCreateModal = $state(false);
	let creating = $state(false);
	let newFolderName = $state('');

	// File upload state
	let uploading = $state(false);
	let dragOver = $state(false);
	let fileInput: HTMLInputElement | undefined = $state();
	let uploadForm: HTMLFormElement | undefined = $state();

	function formatFileSize(bytes: number | undefined): string {
		if (!bytes) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		dragOver = true;
	}

	function handleDragLeave(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;

		const files = e.dataTransfer?.files;
		if (files && files.length > 0 && fileInput) {
			const dt = new DataTransfer();
			dt.items.add(files[0]);
			fileInput.files = dt.files;
			uploadForm?.requestSubmit();
		}
	}

	function handleFileSelect() {
		if (fileInput?.files?.length) {
			uploadForm?.requestSubmit();
		}
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary text-2xl font-bold">Box.com Folders</h2>
			<p class="tron-text-muted text-sm">Manage subfolders within Inventory & Materials</p>
		</div>
		<div class="flex gap-2">
			<a href="/bom/settings">
				<TronButton>
					<svg class="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
						/>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
						/>
					</svg>
					Settings
				</TronButton>
			</a>
			{#if data.connected}
				<TronButton variant="primary" onclick={() => (showCreateModal = true)}>
					<svg class="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
						/>
					</svg>
					New Folder
				</TronButton>
			{/if}
		</div>
	</div>

	{#if !data.connected}
		<TronCard>
			<div class="py-12 text-center">
				<svg
					class="mx-auto mb-4 h-16 w-16 text-[var(--color-tron-text-secondary)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="1.5"
						d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
					/>
				</svg>
				<h3 class="tron-text-primary mb-2 text-lg font-medium">Box.com Not Connected</h3>
				<p class="tron-text-muted mb-4">Connect to Box.com to manage folders.</p>
				<a href="/bom/settings">
					<TronButton variant="primary">Connect to Box</TronButton>
				</a>
			</div>
		</TronCard>
	{:else if data.error}
		<TronCard>
			<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-4">
				<p class="text-[var(--color-tron-red)]">{data.error}</p>
			</div>
		</TronCard>
	{:else}
		<!-- Breadcrumb -->
		<div class="flex items-center gap-2 text-sm">
			<a href="/bom/folders" class="text-[var(--color-tron-cyan)] hover:underline">
				Inventory & Materials
			</a>
			{#if !data.isRoot}
				<span class="tron-text-muted">/</span>
				<span class="tron-text-primary">Subfolder</span>
			{/if}
		</div>

		<!-- File Upload Drop Zone -->
		<form
			bind:this={uploadForm}
			method="POST"
			action="?/uploadFile"
			enctype="multipart/form-data"
			use:enhance={() => {
				uploading = true;
				return async ({ result, update }) => {
					uploading = false;
					if (fileInput) fileInput.value = '';
					await update();
				};
			}}
		>
			<input type="hidden" name="parentFolderId" value={data.folderId} />
			<input
				bind:this={fileInput}
				type="file"
				name="file"
				class="hidden"
				onchange={handleFileSelect}
			/>

			<div
				class="rounded-lg border-2 border-dashed p-6 text-center transition-colors {dragOver
					? 'border-[var(--color-tron-cyan)] bg-[rgba(0,212,255,0.1)]'
					: 'border-[var(--color-tron-border)] hover:border-[var(--color-tron-cyan)]'}"
				role="button"
				tabindex="0"
				ondragover={handleDragOver}
				ondragleave={handleDragLeave}
				ondrop={handleDrop}
				onclick={() => fileInput?.click()}
				onkeydown={(e) => e.key === 'Enter' && fileInput?.click()}
			>
				{#if uploading}
					<div class="flex items-center justify-center gap-3">
						<svg
							class="h-6 w-6 animate-spin text-[var(--color-tron-cyan)]"
							fill="none"
							viewBox="0 0 24 24"
						>
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
						<span class="tron-text-primary">Uploading...</span>
					</div>
				{:else}
					<svg
						class="mx-auto mb-2 h-10 w-10 text-[var(--color-tron-text-secondary)]"
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
					<p class="tron-text-primary mb-1">Drag & drop a file here, or click to select</p>
					<p class="tron-text-muted text-xs">Max file size: 50MB</p>
				{/if}
			</div>
		</form>

		{#if form?.uploadError}
			<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
				<p class="text-sm text-[var(--color-tron-red)]">{form.uploadError}</p>
			</div>
		{/if}

		{#if form?.uploadSuccess}
			<div class="rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,136,0.1)] p-3">
				<p class="text-sm text-[var(--color-tron-green)]">File uploaded successfully!</p>
			</div>
		{/if}

		<!-- Folders -->
		{#if data.folders && data.folders.length > 0}
			<div>
				<h3 class="tron-text-primary mb-3 text-lg font-medium">Folders</h3>
				<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{#each data.folders as folder}
						<a href="/bom/folders?folder={folder.id}" class="block">
							<TronCard interactive>
								<div class="flex items-center gap-3">
									<div
										class="flex h-10 w-10 items-center justify-center rounded bg-[var(--color-tron-bg-tertiary)]"
									>
										<svg
											class="h-6 w-6 text-[var(--color-tron-cyan)]"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
												d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
											/>
										</svg>
									</div>
									<div class="min-w-0 flex-1">
										<div class="tron-text-primary truncate font-medium">{folder.name}</div>
										<div class="tron-text-muted text-xs">Folder</div>
									</div>
								</div>
							</TronCard>
						</a>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Files -->
		{#if data.files && data.files.length > 0}
			<div>
				<h3 class="tron-text-primary mb-3 text-lg font-medium">Files</h3>
				<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{#each data.files as file}
						<TronCard>
							<div class="flex items-center gap-3">
								<div
									class="flex h-10 w-10 items-center justify-center rounded bg-[var(--color-tron-bg-tertiary)]"
								>
									<svg
										class="h-6 w-6 text-[var(--color-tron-text-secondary)]"
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
								</div>
								<div class="min-w-0 flex-1">
									<div class="tron-text-primary truncate font-medium">{file.name}</div>
									<div class="tron-text-muted text-xs">{formatFileSize(file.size)}</div>
								</div>
							</div>
						</TronCard>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Empty State -->
		{#if (!data.folders || data.folders.length === 0) && (!data.files || data.files.length === 0)}
			<TronCard>
				<div class="py-8 text-center">
					<svg
						class="mx-auto mb-4 h-12 w-12 text-[var(--color-tron-text-secondary)]"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="1.5"
							d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
						/>
					</svg>
					<h3 class="tron-text-primary mb-2 font-medium">Folder is Empty</h3>
					<p class="tron-text-muted mb-4 text-sm">
						Upload files or create subfolders to organize your materials.
					</p>
					<TronButton variant="primary" onclick={() => (showCreateModal = true)}
						>Create Folder</TronButton
					>
				</div>
			</TronCard>
		{/if}
	{/if}
</div>

<!-- Create Folder Modal -->
{#if showCreateModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
		<div class="w-full max-w-md">
			<TronCard>
				<div class="mb-6 flex items-center justify-between">
					<h3 class="tron-text-primary text-xl font-bold">Create New Folder</h3>
					<button
						type="button"
						class="tron-text-muted hover:tron-text-primary"
						onclick={() => {
							showCreateModal = false;
							newFolderName = '';
						}}
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
					action="?/createFolder"
					use:enhance={() => {
						creating = true;
						return async ({ result, update }) => {
							creating = false;
							await update();
							if (result.type === 'success') {
								showCreateModal = false;
								newFolderName = '';
							}
						};
					}}
					class="space-y-4"
				>
					<input type="hidden" name="parentFolderId" value={data.folderId} />

					<div>
						<label for="folderName" class="tron-label">Folder Name</label>
						<TronInput
							id="folderName"
							name="folderName"
							type="text"
							placeholder="Enter folder name"
							required
							disabled={creating}
						/>
						<p class="tron-text-muted mt-1 text-xs">
							Folder will be created inside "Inventory & Materials"
						</p>
					</div>

					{#if form?.error}
						<div
							class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3"
						>
							<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
						</div>
					{/if}

					<div class="flex gap-3 pt-2">
						<TronButton
							type="button"
							class="flex-1"
							onclick={() => {
								showCreateModal = false;
								newFolderName = '';
							}}
							disabled={creating}
						>
							Cancel
						</TronButton>
						<TronButton type="submit" variant="primary" class="flex-1" disabled={creating}>
							{#if creating}
								Creating...
							{:else}
								Create Folder
							{/if}
						</TronButton>
					</div>
				</form>
			</TronCard>
		</div>
	</div>
{/if}
