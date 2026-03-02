<script lang="ts">
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	let showUploadModal = $state(false);
	let uploadFile = $state<File | null>(null);
	let uploading = $state(false);
	let uploadError = $state<string | null>(null);
	let uploadSuccess = $state<string | null>(null);

	async function handleUpload() {
		if (!uploadFile || !data.currentFolderId) return;

		uploading = true;
		uploadError = null;

		const formData = new FormData();
		formData.append('file', uploadFile);
		formData.append('folderId', data.currentFolderId);

		try {
			const res = await fetch('/api/box/upload', {
				method: 'POST',
				body: formData
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({ message: res.statusText }));
				uploadError = err.message || 'Upload failed';
				return;
			}

			const result = await res.json();
			uploadSuccess = `Uploaded "${result.file.name}" successfully`;
			showUploadModal = false;
			uploadFile = null;
			await invalidateAll();
		} catch {
			uploadError = 'Network error during upload';
		} finally {
			uploading = false;
		}
	}

	function getFileIcon(name: string): string {
		const ext = name.split('.').pop()?.toLowerCase() ?? '';
		if (['xls', 'xlsx', 'csv'].includes(ext)) return 'spreadsheet';
		if (['pdf'].includes(ext)) return 'pdf';
		if (['doc', 'docx', 'txt', 'rtf'].includes(ext)) return 'document';
		if (['jpg', 'jpeg', 'png', 'gif', 'svg'].includes(ext)) return 'image';
		return 'file';
	}

	function formatFileSize(bytes: number | null): string {
		if (!bytes) return '';
		if (bytes < 1024) return bytes + ' B';
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
		return (bytes / 1024 / 1024).toFixed(1) + ' MB';
	}

	function buildFolderUrl(folderId: string, folderName: string): string {
		const newBreadcrumbs = [...data.breadcrumbs, { id: folderId, name: folderName }];
		const params = new URLSearchParams({
			folderId,
			breadcrumbs: JSON.stringify(newBreadcrumbs)
		});
		return `/spu/documents/box?${params.toString()}`;
	}

	function buildBreadcrumbUrl(index: number): string {
		if (index < 0) {
			// Root folder
			return '/spu/documents/box';
		}
		const crumb = data.breadcrumbs[index];
		const trimmedBreadcrumbs = data.breadcrumbs.slice(0, index + 1);
		const params = new URLSearchParams({
			folderId: crumb.id,
			breadcrumbs: JSON.stringify(trimmedBreadcrumbs)
		});
		return `/spu/documents/box?${params.toString()}`;
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<a
				href="/spu/documents"
				class="tron-text-muted mb-2 inline-flex items-center gap-1 text-sm hover:text-[var(--color-tron-cyan)]"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M15 19l-7-7 7-7"
					/>
				</svg>
				Back to Documents
			</a>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">Box.com Files</h2>
			<p class="tron-text-muted">Browse files in "{data.targetFolder}"</p>
		</div>
		<div class="flex gap-2">
			{#if data.connected && data.currentFolderId}
				<TronButton variant="primary" onclick={() => (showUploadModal = true)}>
					<svg class="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
						/>
					</svg>
					Upload
				</TronButton>
			{/if}
			<a href="/spu/bom/settings">
				<TronButton variant="default">
					<svg class="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
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
		</div>
	</div>

	{#if !data.connected}
		<!-- Not Connected State -->
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
						d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
					/>
				</svg>
				<h3 class="tron-text-primary mb-2 text-lg font-medium">Not Connected to Box.com</h3>
				<p class="tron-text-muted mb-6">
					Connect to Box.com to browse files in the "{data.targetFolder}" folder.
				</p>
				<a href="/spu/bom/settings">
					<TronButton variant="primary">Go to Box Settings</TronButton>
				</a>
			</div>
		</TronCard>
	{:else}
		<!-- Breadcrumbs -->
		<nav class="flex items-center gap-1 text-sm">
			<a
				href={buildBreadcrumbUrl(-1)}
				class="flex items-center gap-1 text-[var(--color-tron-cyan)] hover:underline"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
					/>
				</svg>
				{data.targetFolder}
			</a>
			{#each data.breadcrumbs as crumb, i}
				<span class="tron-text-muted">/</span>
				{#if i === data.breadcrumbs.length - 1}
					<span class="tron-text-primary font-medium">{crumb.name}</span>
				{:else}
					<a href={buildBreadcrumbUrl(i)} class="text-[var(--color-tron-cyan)] hover:underline">
						{crumb.name}
					</a>
				{/if}
			{/each}
		</nav>

		{#if data.error}
			<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-4">
				<p class="text-sm text-[var(--color-tron-red)]">{data.error}</p>
			</div>
		{/if}

		<!-- File/Folder List -->
		<TronCard>
			<div class="mb-4 flex items-center justify-between">
				<h3 class="tron-text-primary text-lg font-medium">{data.currentFolderName}</h3>
				<span class="tron-text-muted text-sm">{data.items.length} items</span>
			</div>

			{#if data.items.length === 0 && !data.error}
				<div class="py-12 text-center">
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
					<p class="tron-text-muted">This folder is empty</p>
				</div>
			{:else}
				<div class="divide-y divide-[var(--color-tron-border)]">
					{#each data.items as item}
						{#if item.type === 'folder'}
							<a
								href={buildFolderUrl(item.id, item.name)}
								class="flex items-center gap-3 px-2 py-3 transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
							>
								<svg
									class="h-6 w-6 flex-shrink-0 text-[var(--color-tron-yellow)]"
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
								<span class="tron-text-primary flex-1 font-medium">{item.name}</span>
								<svg
									class="h-5 w-5 text-[var(--color-tron-text-secondary)]"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M9 5l7 7-7 7"
									/>
								</svg>
							</a>
						{:else}
							<div class="flex items-center gap-3 px-2 py-3">
								{#if getFileIcon(item.name) === 'spreadsheet'}
									<svg
										class="h-6 w-6 flex-shrink-0 text-[var(--color-tron-green)]"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
										/>
									</svg>
								{:else if getFileIcon(item.name) === 'pdf'}
									<svg
										class="h-6 w-6 flex-shrink-0 text-[var(--color-tron-red)]"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
										/>
									</svg>
								{:else if getFileIcon(item.name) === 'image'}
									<svg
										class="h-6 w-6 flex-shrink-0 text-[var(--color-tron-cyan)]"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
										/>
									</svg>
								{:else}
									<svg
										class="h-6 w-6 flex-shrink-0 text-[var(--color-tron-cyan)]"
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
								{/if}
								<div class="flex-1">
									<span class="tron-text-primary font-medium">{item.name}</span>
									{#if item.size}
										<span class="tron-text-muted ml-2 text-sm">{formatFileSize(item.size)}</span>
									{/if}
								</div>
								<TronBadge variant="neutral"
									>{item.name.split('.').pop()?.toUpperCase() ?? 'FILE'}</TronBadge
								>
								<a
									href="/api/box/files/{item.id}"
									class="ml-2 flex items-center gap-1 text-sm text-[var(--color-tron-cyan)] hover:underline"
									download
								>
									<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
										/>
									</svg>
									Download
								</a>
							</div>
						{/if}
					{/each}
				</div>
			{/if}
		</TronCard>
	{/if}
</div>

<!-- Upload Modal -->
{#if showUploadModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
		<div
			class="w-full max-w-md rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6 shadow-xl"
		>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Upload File</h3>

			{#if uploadError}
				<div
					class="mb-4 rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3"
				>
					<p class="text-sm text-[var(--color-tron-red)]">{uploadError}</p>
				</div>
			{/if}

			{#if uploadSuccess}
				<div
					class="mb-4 rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,136,0.1)] p-3"
				>
					<p class="text-sm text-[var(--color-tron-green)]">{uploadSuccess}</p>
				</div>
			{/if}

			<label class="block">
				<span class="tron-text-muted mb-1 block text-sm">Select a file</span>
				<input
					type="file"
					class="block w-full text-sm text-[var(--color-tron-text-secondary)] file:mr-4 file:rounded file:border file:border-[var(--color-tron-border)] file:bg-[var(--color-tron-bg-tertiary)] file:px-4 file:py-2 file:text-sm file:text-[var(--color-tron-cyan)]"
					onchange={(e) => {
						const target = e.currentTarget;
						uploadFile = target.files?.[0] ?? null;
						uploadError = null;
						uploadSuccess = null;
					}}
				/>
			</label>

			{#if uploadFile}
				<p class="tron-text-muted mt-2 text-sm">
					{uploadFile.name} ({formatFileSize(uploadFile.size)})
				</p>
			{/if}

			<div class="mt-6 flex justify-end gap-3">
				<TronButton
					variant="default"
					onclick={() => {
						showUploadModal = false;
						uploadFile = null;
						uploadError = null;
						uploadSuccess = null;
					}}
				>
					Cancel
				</TronButton>
				<TronButton variant="primary" onclick={handleUpload} disabled={!uploadFile || uploading}>
					{uploading ? 'Uploading...' : 'Upload'}
				</TronButton>
			</div>
		</div>
	</div>
{/if}
