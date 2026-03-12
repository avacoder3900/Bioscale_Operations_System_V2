<script lang="ts">
	import { TronCard, TronBadge } from '$lib/components/ui';
	import { enhance } from '$app/forms';

	interface Revision {
		id: string;
		revisionNumber: number;
		documentUrl: string;
		renderedHtmlUrl: string | null;
		changeNotes: string | null;
		isCurrent: boolean;
		uploadedAt: Date | string;
		uploadedByName: string | null;
	}

	interface Props {
		revisions: Revision[];
		partDefinitionId: string;
		ipError?: string | null;
		ipSuccess?: boolean;
	}

	let { revisions, partDefinitionId, ipError = null, ipSuccess = false }: Props = $props();

	let showUpload = $state(false);
	let uploading = $state(false);
	let changeNotes = $state('');

	function formatDateTime(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleString();
	}

	function resetForm() {
		showUpload = false;
		changeNotes = '';
	}
</script>

<TronCard>
	<div class="mb-4 flex items-center justify-between">
		<div class="flex items-center gap-2">
			<h3 class="tron-text-primary text-lg font-semibold">Inspection Procedure Revisions</h3>
			<TronBadge variant="warning">IP</TronBadge>
		</div>
		{#if !showUpload}
			<button
				type="button"
				class="rounded border border-[var(--color-tron-cyan)] px-3 py-1.5 text-sm font-medium text-[var(--color-tron-cyan)] transition hover:bg-[color-mix(in_srgb,var(--color-tron-cyan)_10%,transparent)]"
				onclick={() => (showUpload = true)}
			>
				Upload New Revision
			</button>
		{/if}
	</div>

	{#if ipSuccess}
		<div
			class="mb-4 rounded border border-[var(--color-tron-green)] bg-[color-mix(in_srgb,var(--color-tron-green)_10%,transparent)] px-4 py-2 text-sm text-[var(--color-tron-green)]"
		>
			Revision uploaded successfully.
		</div>
	{/if}
	{#if ipError}
		<div
			class="mb-4 rounded border border-[var(--color-tron-error)] bg-[color-mix(in_srgb,var(--color-tron-error)_10%,transparent)] px-4 py-2 text-sm text-[var(--color-tron-error)]"
		>
			{ipError}
		</div>
	{/if}

	{#if showUpload}
		<div
			class="mb-4 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4"
		>
			<form
				method="POST"
				action="?/uploadIpRevision"
				enctype="multipart/form-data"
				use:enhance={() => {
					uploading = true;
					return async ({ update }) => {
						uploading = false;
						resetForm();
						await update();
					};
				}}
			>
				<input type="hidden" name="partDefinitionId" value={partDefinitionId} />

				<div class="space-y-3">
					<div>
						<label
							for="ip-file-input"
							class="mb-1 block text-sm text-[var(--color-tron-text-secondary)]"
						>
							Word Document (.docx)
						</label>
						<input
							id="ip-file-input"
							type="file"
							name="file"
							accept=".docx"
							required
							class="block w-full text-sm text-[var(--color-tron-text)] file:mr-3 file:rounded file:border file:border-[var(--color-tron-border)] file:bg-[var(--color-tron-bg-tertiary)] file:px-3 file:py-1.5 file:text-sm file:text-[var(--color-tron-text)]"
						/>
					</div>
					<div>
						<label
							for="ip-change-notes"
							class="mb-1 block text-sm text-[var(--color-tron-text-secondary)]"
						>
							Change Notes
						</label>
						<textarea
							id="ip-change-notes"
							name="changeNotes"
							bind:value={changeNotes}
							rows="2"
							placeholder="Describe what changed in this revision..."
							class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
						></textarea>
					</div>
					<div class="flex gap-2">
						<button
							type="submit"
							disabled={uploading}
							class="rounded bg-[var(--color-tron-cyan)] px-4 py-1.5 text-sm font-semibold text-black transition disabled:opacity-50"
						>
							{uploading ? 'Uploading...' : 'Upload Revision'}
						</button>
						<button
							type="button"
							onclick={resetForm}
							class="rounded border border-[var(--color-tron-border)] px-4 py-1.5 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]"
						>
							Cancel
						</button>
					</div>
				</div>
			</form>
		</div>
	{/if}

	{#if revisions.length === 0}
		<p class="tron-text-muted py-4 text-center text-sm">
			No inspection procedure revisions uploaded yet.
		</p>
	{:else}
		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead>
					<tr class="tron-border-b border-b">
						<th class="tron-text-muted px-3 py-2 font-medium">Rev #</th>
						<th class="tron-text-muted px-3 py-2 font-medium">Uploaded By</th>
						<th class="tron-text-muted px-3 py-2 font-medium">Date</th>
						<th class="tron-text-muted px-3 py-2 font-medium">Change Notes</th>
						<th class="tron-text-muted px-3 py-2 font-medium">Status</th>
						<th class="tron-text-muted px-3 py-2 font-medium">Download</th>
					</tr>
				</thead>
				<tbody>
					{#each revisions as rev (rev.id)}
						<tr class="tron-border-b hover:bg-white/5 border-b">
							<td class="px-3 py-2 font-mono">{rev.revisionNumber}</td>
							<td class="tron-text-muted px-3 py-2 text-sm">{rev.uploadedByName ?? 'Unknown'}</td>
							<td class="px-3 py-2 text-sm">{formatDateTime(rev.uploadedAt)}</td>
							<td class="tron-text-muted max-w-xs truncate px-3 py-2 text-sm">{rev.changeNotes || '—'}</td>
							<td class="px-3 py-2">
								{#if rev.isCurrent}
									<TronBadge variant="success">Current</TronBadge>
								{:else}
									<TronBadge variant="neutral">Superseded</TronBadge>
								{/if}
							</td>
							<td class="px-3 py-2">
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a
									href={rev.documentUrl}
									target="_blank"
									rel="noopener noreferrer"
									class="text-sm text-[var(--color-tron-cyan)] hover:underline"
								>
									.docx
								</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</TronCard>
