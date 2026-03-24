<script lang="ts">
	import { enhance } from '$app/forms';

	interface WorkInstruction {
		id: string;
		documentNumber: string;
		title: string;
		description: string | null;
		status: string;
		currentVersion: number;
		createdAt: Date;
		updatedAt: Date;
		activeRunCount: number;
	}

	interface Props {
		data: {
			workInstructions: WorkInstruction[];
			canEdit: boolean;
			canDelete: boolean;
		};
		form: {
			success?: boolean;
			deleted?: boolean;
			error?: string;
			deleteError?: string;
		} | null;
	}

	let { data, form }: Props = $props();

	// Edit state
	let editingId = $state<string | null>(null);
	let editTitle = $state('');
	let editDescription = $state('');
	let saving = $state(false);

	// Delete state
	let confirmDeleteId = $state<string | null>(null);
	let deleting = $state(false);

	function startEdit(wi: WorkInstruction, event: Event) {
		event.preventDefault();
		event.stopPropagation();
		editingId = wi.id;
		editTitle = wi.title;
		editDescription = wi.description ?? '';
	}

	function cancelEdit() {
		editingId = null;
		editTitle = '';
		editDescription = '';
	}

	function startDelete(wi: WorkInstruction, event: Event) {
		event.preventDefault();
		event.stopPropagation();
		confirmDeleteId = wi.id;
	}

	function cancelDelete() {
		confirmDeleteId = null;
	}

	// Reset edit state on successful save
	$effect(() => {
		if (form?.success && !form?.deleted) {
			editingId = null;
		}
	});

	function getStatusColor(status: string): string {
		switch (status) {
			case 'active':
				return 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]';
			case 'draft':
				return 'bg-[var(--color-tron-yellow)]/20 text-[var(--color-tron-yellow)]';
			case 'archived':
				return 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]';
			default:
				return 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text-secondary)]';
		}
	}
</script>

<svelte:head>
	<title>Work Instructions | SPU Documents</title>
</svelte:head>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Work Instructions</h1>
			<p class="tron-text-muted mt-1">Select a work instruction to start a production run</p>
		</div>
		<a href="/spu/documents/upload" class="tron-btn-primary flex items-center gap-2">
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

	{#if form?.deleteError}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.deleteError}</p>
		</div>
	{/if}

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		</div>
	{/if}

	{#if data.workInstructions.length === 0}
		<div class="tron-card p-12 text-center">
			<svg
				class="mx-auto h-12 w-12 text-[var(--color-tron-text-secondary)]"
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
			<p class="tron-text-muted mt-4">No work instructions yet</p>
			<p class="tron-text-muted mt-1 text-sm">Upload a work instruction to get started.</p>
			<a href="/spu/documents/upload" class="tron-btn-primary mt-6 inline-block">
				Upload Work Instruction
			</a>
		</div>
	{:else}
		<div class="wi-grid">
			{#each data.workInstructions as wi (wi.id)}
				{#if editingId === wi.id}
					<!-- Inline Edit Form -->
					<div class="wi-card wi-card-editing">
						<form
							method="POST"
							action="?/updateInstruction"
							use:enhance={() => {
								saving = true;
								return async ({ update }) => {
									saving = false;
									await update();
								};
							}}
						>
							<input type="hidden" name="id" value={wi.id} />
							<div class="mb-2">
								<span class="font-mono text-sm tron-text-muted">{wi.documentNumber}</span>
							</div>
							<div class="mb-3">
								<label for="edit-title-{wi.id}" class="tron-label">Title</label>
								<input
									id="edit-title-{wi.id}"
									name="title"
									type="text"
									class="tron-input"
									required
									bind:value={editTitle}
									disabled={saving}
									style="min-height: 44px;"
								/>
							</div>
							<div class="mb-3">
								<label for="edit-desc-{wi.id}" class="tron-label">Description</label>
								<textarea
									id="edit-desc-{wi.id}"
									name="description"
									class="tron-input"
									rows="2"
									bind:value={editDescription}
									disabled={saving}
									style="min-height: 44px;"
								></textarea>
							</div>
							<div class="flex gap-2">
								<button
									type="button"
									class="tron-btn-secondary flex-1 text-sm"
									onclick={cancelEdit}
									disabled={saving}
									style="min-height: 44px;"
								>
									Cancel
								</button>
								<button
									type="submit"
									class="tron-btn-primary flex-1 text-sm"
									disabled={saving}
									style="min-height: 44px;"
								>
									{saving ? 'Saving...' : 'Save'}
								</button>
							</div>
						</form>
					</div>
				{:else if confirmDeleteId === wi.id}
					<!-- Delete Confirmation -->
					<div class="wi-card wi-card-deleting">
						<p class="tron-text-primary font-medium mb-2">Delete this work instruction?</p>
						<p class="font-mono text-sm text-[var(--color-tron-cyan)] mb-1">{wi.documentNumber}</p>
						<p class="tron-text-muted text-sm mb-4">{wi.title}</p>
						<form
							method="POST"
							action="?/deleteInstruction"
							use:enhance={() => {
								deleting = true;
								return async ({ update }) => {
									deleting = false;
									confirmDeleteId = null;
									await update();
								};
							}}
						>
							<input type="hidden" name="id" value={wi.id} />
							<div class="flex gap-2">
								<button
									type="button"
									class="tron-btn-secondary flex-1 text-sm"
									onclick={cancelDelete}
									disabled={deleting}
									style="min-height: 44px;"
								>
									Cancel
								</button>
								<button
									type="submit"
									class="flex-1 rounded-lg bg-[var(--color-tron-red)] px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
									disabled={deleting}
									style="min-height: 44px;"
								>
									{deleting ? 'Deleting...' : 'Delete'}
								</button>
							</div>
						</form>
					</div>
				{:else}
					<!-- Normal Card -->
					<a href="/spu/documents/instructions/{wi.id}" class="wi-card">
						<div class="flex items-center justify-between mb-2">
							<span class="font-mono text-lg font-bold text-[var(--color-tron-cyan)]">
								{wi.documentNumber}
							</span>
							<div class="flex items-center gap-2">
								<span
									class="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold capitalize {getStatusColor(
										wi.status
									)}"
								>
									{wi.status}
								</span>
								{#if data.canEdit}
									<button
										onclick={(e) => startEdit(wi, e)}
										class="action-icon"
										title="Edit"
									>
										<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
										</svg>
									</button>
								{/if}
								{#if data.canDelete}
									<button
										onclick={(e) => startDelete(wi, e)}
										class="action-icon action-icon-danger"
										title="Delete"
									>
										<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
										</svg>
									</button>
								{/if}
							</div>
						</div>
						<p class="tron-text-primary text-left font-medium">{wi.title}</p>
						<div class="mt-3 flex items-center gap-3">
							<span class="tron-text-muted text-xs">v{wi.currentVersion}</span>
							{#if wi.activeRunCount > 0}
								<span
									class="inline-flex items-center gap-1 rounded-full bg-[var(--color-tron-cyan)]/15 px-2 py-0.5 text-xs font-semibold text-[var(--color-tron-cyan)]"
								>
									<svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M13 10V3L4 14h7v7l9-11h-7z"
										/>
									</svg>
									{wi.activeRunCount} active run{wi.activeRunCount !== 1 ? 's' : ''}
								</span>
							{/if}
						</div>
					</a>
				{/if}
			{/each}
		</div>
	{/if}
</div>

<style>
	.wi-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
		gap: 1rem;
	}

	.wi-card {
		display: flex;
		flex-direction: column;
		padding: 1.25rem;
		background: var(--color-tron-bg-secondary);
		border: 1px solid var(--color-tron-border);
		border-radius: 0.5rem;
		cursor: pointer;
		transition: all 0.15s;
		min-height: 44px;
		text-align: left;
		text-decoration: none;
		color: inherit;
	}

	.wi-card:hover {
		border-color: var(--color-tron-cyan);
		background: color-mix(in srgb, var(--color-tron-cyan) 5%, var(--color-tron-bg-secondary));
		transform: translateY(-1px);
	}

	.wi-card-editing {
		border-color: var(--color-tron-cyan);
		cursor: default;
	}

	.wi-card-editing:hover {
		transform: none;
	}

	.wi-card-deleting {
		border-color: var(--color-tron-red);
		cursor: default;
	}

	.wi-card-deleting:hover {
		border-color: var(--color-tron-red);
		background: color-mix(in srgb, var(--color-tron-red) 5%, var(--color-tron-bg-secondary));
		transform: none;
	}

	.action-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: 0.375rem;
		color: var(--color-tron-text-secondary);
		transition: all 0.15s;
	}

	.action-icon:hover {
		color: var(--color-tron-cyan);
		background: var(--color-tron-bg-tertiary);
	}

	.action-icon-danger:hover {
		color: var(--color-tron-red);
	}
</style>
