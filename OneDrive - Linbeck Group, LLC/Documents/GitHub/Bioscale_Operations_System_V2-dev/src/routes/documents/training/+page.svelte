<script lang="ts">
	import { goto } from '$app/navigation';
	import { TronCard, TronButton } from '$lib/components/ui';

	let { data } = $props();

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}
</script>

<div class="space-y-6">
	<h2 class="tron-text-primary text-2xl font-bold">My Training</h2>

	<!-- Required Training Section -->
	<TronCard>
		<h3 class="tron-text-primary mb-4 text-lg font-bold">
			Required Training
			{#if data.pendingTraining.length > 0}
				<span
					class="ml-2 rounded-full bg-[var(--color-tron-orange)] px-2 py-0.5 text-sm text-black"
				>
					{data.pendingTraining.length}
				</span>
			{/if}
		</h3>

		{#if data.pendingTraining.length === 0}
			<div class="py-8 text-center">
				<svg
					class="mx-auto h-12 w-12 text-[var(--color-tron-green)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
					/>
				</svg>
				<p class="tron-text-muted mt-4">You're up to date on all required training.</p>
			</div>
		{:else}
			<div class="space-y-3">
				{#each data.pendingTraining as doc}
					<div
						class="flex items-center justify-between rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-4"
					>
						<div>
							<div class="flex items-center gap-2">
								<span class="font-mono text-sm text-[var(--color-tron-cyan)]">
									{doc.documentNumber}
								</span>
								<span class="tron-text-primary font-medium">{doc.title}</span>
							</div>
							<div class="tron-text-muted mt-1 text-sm">
								Revision {doc.currentRevision}
								{#if doc.category}
									• {doc.category}
								{/if}
							</div>
						</div>
						<TronButton
							variant="primary"
							onclick={() => goto(`/documents/${doc.documentId}/train`)}
						>
							Complete Training
						</TronButton>
					</div>
				{/each}
			</div>
		{/if}
	</TronCard>

	<!-- Completed Training Section -->
	<TronCard>
		<h3 class="tron-text-primary mb-4 text-lg font-bold">Completed Training</h3>

		{#if data.completedTraining.length === 0}
			<p class="tron-text-muted py-4 text-center">No training records yet.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Document</th>
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Revision</th>
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Trained</th>
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Trainer</th>
						</tr>
					</thead>
					<tbody>
						{#each data.completedTraining as training}
							<tr class="border-b border-[var(--color-tron-border)]">
								<td class="px-4 py-3">
									<div class="flex flex-col">
										<span class="font-mono text-sm text-[var(--color-tron-cyan)]">
											{training.documentNumber}
										</span>
										<span class="tron-text-primary text-sm">{training.documentTitle}</span>
									</div>
								</td>
								<td class="px-4 py-3">
									<span class="font-mono text-[var(--color-tron-text-secondary)]">
										{training.revision}
									</span>
								</td>
								<td class="tron-text-secondary px-4 py-3">{formatDate(training.trainedAt)}</td>
								<td class="tron-text-secondary px-4 py-3">{training.trainerUsername ?? 'Self'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</TronCard>
</div>
