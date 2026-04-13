<script lang="ts">
	import { goto } from '$app/navigation';

	let { data } = $props();
	let selectedProject = $state(data.filters.projectId);
	let selectedLabel = $state(data.filters.label);
	let lightbox = $state<any>(null);
	let bulkMode = $state(false);
	let selected = $state<Set<string>>(new Set());
	let bulkLabeling = $state(false);
	let fullscreen = $state(false);

	function applyFilters() {
		const params = new URLSearchParams();
		if (selectedProject) params.set('projectId', selectedProject);
		if (selectedLabel) params.set('label', selectedLabel);
		goto(`/cv/gallery?${params.toString()}`);
	}

	function clearFilters() {
		selectedProject = '';
		selectedLabel = '';
		goto('/cv/gallery');
	}

	function toggleSelect(id: string) {
		const s = new Set(selected);
		if (s.has(id)) s.delete(id); else s.add(id);
		selected = s;
	}

	async function bulkLabel(label: string) {
		bulkLabeling = true;
		for (const id of selected) {
			try {
				await fetch(`/api/cv/images/${id}/label`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ label })
				});
			} catch { /* skip */ }
		}
		selected = new Set();
		bulkLabeling = false;
		location.reload();
	}

	async function labelImage(id: string, label: string | null) {
		await fetch(`/api/cv/images/${id}/label`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ label })
		});
		if (lightbox && lightbox._id === id) lightbox.label = label;
		const img = data.images.find((i: any) => i._id === id);
		if (img) img.label = label;
		data.images = [...data.images];
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h2 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Image Gallery</h2>
		<div class="flex gap-2">
			<button
				class="rounded-lg border px-3 py-1.5 text-sm {bulkMode ? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}"
				onclick={() => { bulkMode = !bulkMode; selected = new Set(); }}
			>
				{bulkMode ? 'Cancel Bulk' : 'Bulk Select'}
			</button>
		</div>
	</div>

	<!-- Filters -->
	<div class="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<div>
			<label for="fProject" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Project</label>
			<select id="fProject" bind:value={selectedProject} class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-tron-text-primary)]">
				<option value="">All projects</option>
				{#each data.projects as p}
					<option value={p._id}>{p.name}</option>
				{/each}
			</select>
		</div>
		<div>
			<label for="fLabel" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Label</label>
			<select id="fLabel" bind:value={selectedLabel} class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-tron-text-primary)]">
				<option value="">All</option>
				<option value="approved">Approved</option>
				<option value="rejected">Rejected</option>
				<option value="unlabeled">Unlabeled</option>
			</select>
		</div>
		<button onclick={applyFilters} class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-1.5 text-sm font-medium text-black hover:opacity-90">Filter</button>
		<button onclick={clearFilters} class="rounded-lg border border-[var(--color-tron-border)] px-4 py-1.5 text-sm text-[var(--color-tron-text-secondary)]">Clear</button>
		<span class="ml-auto text-sm text-[var(--color-tron-text-secondary)]">{data.total} images</span>
	</div>

	<!-- Bulk Actions -->
	{#if bulkMode && selected.size > 0}
		<div class="flex items-center gap-3 rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 p-3">
			<span class="text-sm text-[var(--color-tron-text-primary)]">{selected.size} selected</span>
			<button onclick={() => bulkLabel('approved')} disabled={bulkLabeling} class="rounded bg-[var(--color-tron-green)]/20 px-3 py-1 text-xs font-semibold text-[var(--color-tron-green)]">Mark Approved</button>
			<button onclick={() => bulkLabel('rejected')} disabled={bulkLabeling} class="rounded bg-[var(--color-tron-red)]/20 px-3 py-1 text-xs font-semibold text-[var(--color-tron-red)]">Mark Rejected</button>
		</div>
	{/if}

	<!-- Image Grid -->
	{#if data.images.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-12 text-center text-[var(--color-tron-text-secondary)]">No images found.</div>
	{:else}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
			{#each data.images as image (image._id)}
				<div
					class="group relative cursor-pointer overflow-hidden rounded-lg border bg-[var(--color-tron-bg-primary)] transition-all {bulkMode && selected.has(image._id) ? 'border-[var(--color-tron-cyan)] ring-2 ring-[var(--color-tron-cyan)]/30' : 'border-[var(--color-tron-border)] hover:border-[var(--color-tron-cyan)]/50'}"
					role="button"
					tabindex="0"
					onclick={() => bulkMode ? toggleSelect(image._id) : (lightbox = image)}
					onkeydown={(e) => e.key === 'Enter' && (bulkMode ? toggleSelect(image._id) : (lightbox = image))}
				>
					<div class="aspect-square bg-[var(--color-tron-bg-tertiary)]">
						{#if image.imageUrl}
							<img src={image.imageUrl} alt={image.filename} class="h-full w-full object-cover" loading="lazy" />
						{:else}
							<div class="flex h-full items-center justify-center text-xs text-[var(--color-tron-text-secondary)]">No image</div>
						{/if}
					</div>
					{#if image.label}
						<span class="absolute left-1 top-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold {image.label === 'approved' ? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]' : 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'}">
							{image.label === 'approved' ? 'GOOD' : 'DEFECT'}
						</span>
					{/if}
					{#if bulkMode}
						<div class="absolute right-1 top-1 h-5 w-5 rounded border {selected.has(image._id) ? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)]'}">
							{#if selected.has(image._id)}<span class="flex h-full items-center justify-center text-xs text-black">&#10003;</span>{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	<!-- Pagination -->
	{#if data.totalPages > 1}
		<div class="flex items-center justify-center gap-2">
			{#if data.page > 1}
				<a href="/cv/gallery?page={data.page - 1}&projectId={data.filters.projectId}&label={data.filters.label}" class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text-primary)]">Prev</a>
			{/if}
			<span class="text-sm text-[var(--color-tron-text-secondary)]">Page {data.page} of {data.totalPages}</span>
			{#if data.page < data.totalPages}
				<a href="/cv/gallery?page={data.page + 1}&projectId={data.filters.projectId}&label={data.filters.label}" class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text-primary)]">Next</a>
			{/if}
		</div>
	{/if}
</div>

<!-- Lightbox -->
{#if lightbox}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4" role="dialog">
		<button class="absolute right-4 top-4 text-2xl text-[var(--color-tron-text-secondary)] hover:text-white" onclick={() => { lightbox = null; fullscreen = false; }}>&times;</button>
		<div class="flex max-h-[90vh] max-w-4xl flex-col gap-4 lg:flex-row">
			<div class="flex-1">
				{#if lightbox.imageUrl}
					<img src={lightbox.imageUrl} alt={lightbox.filename} class="max-h-[70vh] cursor-pointer rounded-lg object-contain" onclick={() => fullscreen = true} />
				{/if}
			</div>
			<div class="w-64 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text-primary)]">{lightbox.filename}</h3>
				<div class="space-y-2 text-xs text-[var(--color-tron-text-secondary)]">
					{#if lightbox.fileSizeBytes}<p>Size: {Math.round(lightbox.fileSizeBytes / 1024)} KB</p>{/if}
					{#if lightbox.capturedAt}<p>Captured: {new Date(lightbox.capturedAt).toLocaleString()}</p>{/if}
				</div>
				<div class="mt-4 flex gap-2">
					<button
						class="flex-1 rounded py-1.5 text-xs font-semibold {lightbox.label === 'approved' ? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}"
						onclick={() => labelImage(lightbox._id, lightbox.label === 'approved' ? null : 'approved')}
					>&#10003; Good</button>
					<button
						class="flex-1 rounded py-1.5 text-xs font-semibold {lightbox.label === 'rejected' ? 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}"
						onclick={() => labelImage(lightbox._id, lightbox.label === 'rejected' ? null : 'rejected')}
					>&#10007; Defect</button>
				</div>
			</div>
		</div>
	</div>
{/if}

<!-- Fullscreen image viewer -->
{#if fullscreen && lightbox?.imageUrl}
	<button class="fixed inset-0 z-[60] flex items-center justify-center bg-black/95 backdrop-blur-sm" onclick={() => fullscreen = false}>
		<img src={lightbox.imageUrl} alt="fullscreen" class="max-h-[95vh] max-w-[95vw] object-contain" />
	</button>
{/if}
