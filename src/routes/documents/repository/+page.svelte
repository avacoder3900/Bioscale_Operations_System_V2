<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { enhance } from '$app/forms';

	interface Document {
		id: string;
		fileName: string;
		originalFileName: string;
		fileSize: number;
		mimeType: string;
		category: string | null;
		tags: string | null;
		description: string | null;
		uploadedBy: string | null;
		uploadedAt: Date;
		uploaderName: string | null;
	}

	interface Props {
		data: {
			documents: Document[];
			search: string;
			totalCount: number;
		};
		form: {
			success?: boolean;
			error?: string;
			content?: string;
			fileName?: string;
			mimeType?: string;
		} | null;
	}

	let { data, form }: Props = $props();

	let searchInput = $state(data.search);

	function handleSearch() {
		const url = new URL($page.url);
		if (searchInput.trim()) {
			url.searchParams.set('search', searchInput.trim());
		} else {
			url.searchParams.delete('search');
		}
		goto(url.toString());
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatDate(date: Date): string {
		return new Date(date).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}

	function getFileIcon(mimeType: string): string {
		if (mimeType.includes('pdf')) return 'PDF';
		if (mimeType.includes('word') || mimeType.includes('document')) return 'DOC';
		if (mimeType.includes('sheet') || mimeType.includes('excel')) return 'XLS';
		if (mimeType.includes('image')) return 'IMG';
		return 'FILE';
	}

	function getFileIconColor(mimeType: string): string {
		if (mimeType.includes('pdf')) return 'text-[var(--color-tron-red)]';
		if (mimeType.includes('word') || mimeType.includes('document'))
			return 'text-[var(--color-tron-cyan)]';
		if (mimeType.includes('sheet') || mimeType.includes('excel'))
			return 'text-[var(--color-tron-green)]';
		return 'text-[var(--color-tron-text-secondary)]';
	}

	// Handle download response
	$effect(() => {
		if (form?.success && form.content && form.fileName && form.mimeType) {
			const byteCharacters = atob(form.content);
			const byteNumbers = new Array(byteCharacters.length);
			for (let i = 0; i < byteCharacters.length; i++) {
				byteNumbers[i] = byteCharacters.charCodeAt(i);
			}
			const byteArray = new Uint8Array(byteNumbers);
			const blob = new Blob([byteArray], { type: form.mimeType });

			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = form.fileName;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		}
	});
</script>

<svelte:head>
	<title>Document Repository | SPU Documents</title>
</svelte:head>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Document Repository</h1>
			<p class="tron-text-muted mt-1">
				{data.totalCount} document{data.totalCount !== 1 ? 's' : ''}
				{#if data.search}
					matching "{data.search}"
				{/if}
			</p>
		</div>
		<a href="/documents/upload" class="tron-btn-primary flex items-center gap-2">
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M12 4v16m8-8H4"
				/>
			</svg>
			Upload New
		</a>
	</div>

	<!-- Search -->
	<div class="tron-card p-4">
		<form onsubmit={(e) => { e.preventDefault(); handleSearch(); }} class="flex gap-3">
			<div class="relative flex-1">
				<svg
					class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-tron-text-secondary)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
					/>
				</svg>
				<input
					type="text"
					bind:value={searchInput}
					placeholder="Search by filename..."
					class="tron-input w-full pl-10"
				/>
			</div>
			<button type="submit" class="tron-btn-secondary">Search</button>
			{#if data.search}
				<button
					type="button"
					onclick={() => { searchInput = ''; handleSearch(); }}
					class="tron-btn-secondary"
				>
					Clear
				</button>
			{/if}
		</form>
	</div>

	<!-- Documents Table -->
	<div class="tron-card overflow-hidden">
		{#if data.documents.length === 0}
			<div class="flex flex-col items-center justify-center py-12">
				<svg
					class="h-12 w-12 text-[var(--color-tron-text-secondary)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
					/>
				</svg>
				<p class="tron-text-muted mt-4">
					{#if data.search}
						No documents match your search
					{:else}
						No documents in repository
					{/if}
				</p>
				<a href="/documents/upload" class="tron-btn-primary mt-4">Upload Document</a>
			</div>
		{:else}
			<table class="w-full">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]">
						<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">File Name</th>
						<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Category</th>
						<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Size</th>
						<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Uploaded</th>
						<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Uploaded By</th>
						<th class="tron-text-muted px-4 py-3 text-right text-sm font-medium">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each data.documents as doc}
						<tr
							class="border-b border-[var(--color-tron-border)] transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
						>
							<td class="px-4 py-3">
								<div class="flex items-center gap-3">
									<div
										class="flex h-8 w-8 items-center justify-center rounded bg-[var(--color-tron-bg-tertiary)]"
									>
										<span class="text-xs font-bold {getFileIconColor(doc.mimeType)}">
											{getFileIcon(doc.mimeType)}
										</span>
									</div>
									<div>
										<p class="tron-text-primary font-medium">{doc.originalFileName || doc.fileName}</p>
										{#if doc.description}
											<p class="tron-text-muted text-sm line-clamp-1">{doc.description}</p>
										{/if}
									</div>
								</div>
							</td>
							<td class="px-4 py-3">
								{#if doc.category}
									<span
										class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]"
									>
										{doc.category}
									</span>
								{:else}
									<span class="tron-text-muted text-sm">-</span>
								{/if}
							</td>
							<td class="px-4 py-3">
								<span class="tron-text-muted text-sm">{formatFileSize(doc.fileSize)}</span>
							</td>
							<td class="px-4 py-3">
								<span class="tron-text-muted text-sm">{formatDate(doc.uploadedAt)}</span>
							</td>
							<td class="px-4 py-3">
								<span class="tron-text-muted text-sm">{doc.uploaderName || '-'}</span>
							</td>
							<td class="px-4 py-3 text-right">
								<form method="POST" action="?/download" use:enhance>
									<input type="hidden" name="documentId" value={doc.id} />
									<button
										type="submit"
										class="inline-flex items-center gap-1 text-sm text-[var(--color-tron-cyan)] hover:underline"
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
									</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</div>
