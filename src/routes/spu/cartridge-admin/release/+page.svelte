<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let expandedRunId = $state<string | null>(null);
	let showCreateLot = $state(false);
	let showCreateRelease = $state(false);
	let selectedRunId = $state<string | null>(null);
	let selectedLotId = $state<string | null>(null);
	let feedbackMessage = $state('');
	let feedbackType = $state<'success' | 'error'>('success');

	const pendingReleases = $derived(
		data.releases.filter((r) => r.testResult === 'pending')
	);
	const pastReleases = $derived(
		data.releases.filter((r) => r.testResult === 'passed' || r.testResult === 'failed')
	);
	const openLots = $derived(data.lots.filter((l) => l.status === 'open'));
	const releasedLots = $derived(data.lots.filter((l) => l.status === 'released'));

	const resultColors: Record<string, string> = {
		pending: 'bg-yellow-900/50 text-yellow-300 border-yellow-500/30',
		passed: 'bg-emerald-900/50 text-emerald-300 border-emerald-500/30',
		failed: 'bg-red-900/50 text-red-300 border-red-500/30'
	};

	const lotStatusColors: Record<string, string> = {
		open: 'bg-yellow-900/50 text-yellow-300 border-yellow-500/30',
		released: 'bg-emerald-900/50 text-emerald-300 border-emerald-500/30',
		shipped: 'bg-blue-900/50 text-blue-300 border-blue-500/30',
		delivered: 'bg-purple-900/50 text-purple-300 border-purple-500/30'
	};

	function handleFormResult(result: { type: string; data?: Record<string, unknown> }) {
		if (result.type === 'success' && result.data?.success) {
			feedbackType = 'success';
			feedbackMessage = (result.data.message as string) ?? 'Action completed successfully';
			showCreateLot = false;
			showCreateRelease = false;
			if (result.data.action === 'createLot') {
				feedbackMessage = `Shipping lot ${result.data.lotId} created`;
			} else if (result.data.action === 'createRelease') {
				feedbackMessage = 'QA/QC release created — awaiting test result';
			}
		} else if (result.type === 'failure' && result.data?.error) {
			feedbackType = 'error';
			feedbackMessage = result.data.error as string;
		}
	}

	function clearFeedback() {
		feedbackMessage = '';
	}

	function startCreateRelease(runId: string) {
		selectedRunId = runId;
		showCreateRelease = true;
	}
</script>

<div class="space-y-6">
	<!-- Feedback -->
	{#if feedbackMessage}
		<div class="flex items-center justify-between rounded border px-4 py-2 text-sm {feedbackType === 'success'
			? 'border-emerald-500/50 bg-emerald-900/20 text-emerald-300'
			: 'border-[var(--color-tron-error)]/50 bg-[var(--color-tron-error)]/10 text-[var(--color-tron-error)]'}"
		>
			<span>{feedbackMessage}</span>
			<button type="button" onclick={clearFeedback} class="ml-4 text-xs opacity-60 hover:opacity-100">Dismiss</button>
		</div>
	{/if}

	<!-- Summary Cards -->
	<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Open Lots</p>
			<p class="text-2xl font-bold text-[var(--color-tron-yellow)]">{openLots.length}</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Released Lots</p>
			<p class="text-2xl font-bold text-emerald-400">{releasedLots.length}</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Pending Tests</p>
			<p class="text-2xl font-bold text-[var(--color-tron-cyan)]">{pendingReleases.length}</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Total Releases</p>
			<p class="text-2xl font-bold text-[var(--color-tron-text)]">{data.releases.length}</p>
		</div>
	</div>

	<!-- Actions Bar -->
	<div class="flex gap-2">
		<button
			type="button"
			onclick={() => { showCreateLot = true; }}
			class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/30"
		>
			+ New Shipping Lot
		</button>
	</div>

	<!-- Create Lot Form -->
	{#if showCreateLot}
		<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)] p-4">
			<h3 class="mb-3 text-sm font-medium text-[var(--color-tron-cyan)]">Create Shipping Lot</h3>
			<form
				method="POST"
				action="?/createShippingLot"
				use:enhance={() => {
					return async ({ result, update }) => {
						handleFormResult(result as { type: string; data?: Record<string, unknown> });
						await update();
					};
				}}
				class="space-y-3"
			>
				<div>
					<label for="lotAssayType" class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Assay Type</label>
					<select
						id="lotAssayType"
						name="assayTypeId"
						required
						class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					>
						<option value="">Select assay type...</option>
						{#each data.assayTypes as at (at.id)}
							<option value={at.id}>{at.name}</option>
						{/each}
					</select>
				</div>
				<div>
					<label for="lotNotes" class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Notes (optional)</label>
					<input
						id="lotNotes"
						name="notes"
						type="text"
						class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					/>
				</div>
				<div class="flex gap-2">
					<button type="submit" class="min-h-[44px] rounded border border-emerald-500/50 bg-emerald-900/20 px-4 py-2 text-sm font-medium text-emerald-300">
						Create Lot
					</button>
					<button type="button" onclick={() => { showCreateLot = false; }} class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">
						Cancel
					</button>
				</div>
			</form>
		</div>
	{/if}

	<!-- Create Release Form -->
	{#if showCreateRelease && selectedRunId}
		{@const run = data.releasableRuns.find((r) => r.runId === selectedRunId)}
		<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)] p-4">
			<h3 class="mb-3 text-sm font-medium text-[var(--color-tron-cyan)]">Start QA/QC Release</h3>
			{#if run}
				<p class="mb-3 text-xs text-[var(--color-tron-text-secondary)]">
					Run <span class="font-mono text-[var(--color-tron-text)]">{run.runId}</span> |
					{run.assayTypeName} |
					{run.qaqcCount} QA/QC cartridge{run.qaqcCount !== 1 ? 's' : ''}
				</p>
			{/if}
			<form
				method="POST"
				action="?/createRelease"
				use:enhance={() => {
					return async ({ result, update }) => {
						handleFormResult(result as { type: string; data?: Record<string, unknown> });
						await update();
					};
				}}
				class="space-y-3"
			>
				<input type="hidden" name="reagentRunId" value={selectedRunId} />
				<input type="hidden" name="qaqcCartridgeIds" value={run?.qaqcCartridgeIds?.join(',') ?? ''} />
				<div>
					<label for="releaseLot" class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Shipping Lot</label>
					<select
						id="releaseLot"
						name="shippingLotId"
						required
						bind:value={selectedLotId}
						class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					>
						<option value="">Select an open lot...</option>
						{#each openLots as lot (lot.id)}
							<option value={lot.id}>{lot.id} — {data.assayTypes.find((a) => a.id === lot.assayTypeId)?.name ?? 'Unknown'}</option>
						{/each}
					</select>
				</div>
				<div>
					<label for="releaseNotes" class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Notes (optional)</label>
					<input
						id="releaseNotes"
						name="notes"
						type="text"
						class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					/>
				</div>
				<div class="flex gap-2">
					<button type="submit" class="min-h-[44px] rounded border border-emerald-500/50 bg-emerald-900/20 px-4 py-2 text-sm font-medium text-emerald-300">
						Create Release
					</button>
					<button type="button" onclick={() => { showCreateRelease = false; }} class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">
						Cancel
					</button>
				</div>
			</form>
		</div>
	{/if}

	<!-- Pending Releases -->
	{#if pendingReleases.length > 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h3 class="mb-3 text-sm font-medium text-[var(--color-tron-yellow)]">
				Pending QA/QC Tests ({pendingReleases.length})
			</h3>
			<div class="space-y-3">
				{#each pendingReleases as release (release.id)}
					<div class="rounded border border-yellow-500/30 bg-yellow-900/10 p-3">
						<div class="flex items-center justify-between">
							<div>
								<span class="font-mono text-sm text-[var(--color-tron-text)]">{release.shippingLotId}</span>
								<span class="ml-2 font-mono text-xs text-[var(--color-tron-text-secondary)]">Run: {release.reagentRunId}</span>
							</div>
							<span class="rounded border px-1.5 py-0.5 text-xs font-medium {resultColors[release.testResult ?? 'pending']}">
								{release.testResult}
							</span>
						</div>
						<div class="mt-2 flex gap-2">
							<form
								method="POST"
								action="?/recordTestResult"
								use:enhance={() => {
									return async ({ result, update }) => {
										handleFormResult(result as { type: string; data?: Record<string, unknown> });
										await update();
									};
								}}
							>
								<input type="hidden" name="releaseId" value={release.id} />
								<input type="hidden" name="testResult" value="passed" />
								<button
									type="submit"
									class="min-h-[44px] rounded border border-emerald-500/50 bg-emerald-900/20 px-4 py-2 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-900/40"
								>
									Pass
								</button>
							</form>
							<form
								method="POST"
								action="?/recordTestResult"
								use:enhance={() => {
									return async ({ result, update }) => {
										handleFormResult(result as { type: string; data?: Record<string, unknown> });
										await update();
									};
								}}
							>
								<input type="hidden" name="releaseId" value={release.id} />
								<input type="hidden" name="testResult" value="failed" />
								<button
									type="submit"
									class="min-h-[44px] rounded border border-red-500/50 bg-red-900/20 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-900/40"
								>
									Fail
								</button>
							</form>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Releasable Runs -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<h3 class="mb-3 text-sm font-medium text-[var(--color-tron-text)]">Reagent Filling Runs</h3>
		{#if data.releasableRuns.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No runs available</p>
		{:else}
			<div class="space-y-2">
				{#each data.releasableRuns as run (run.runId)}
					<button
						type="button"
						onclick={() => { expandedRunId = expandedRunId === run.runId ? null : run.runId; }}
						class="w-full rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg)] p-3 text-left transition-colors hover:border-[var(--color-tron-cyan)]/50"
					>
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-3">
								<span class="font-mono text-sm text-[var(--color-tron-text)]">{run.runId}</span>
								<span class="text-xs text-[var(--color-tron-text-secondary)]">{run.assayTypeName}</span>
							</div>
							<div class="flex items-center gap-3 text-xs">
								<span class="text-[var(--color-tron-text-secondary)]">{run.totalCartridges} total</span>
								<span class="text-emerald-400">{run.acceptedCount} accepted</span>
								{#if run.qaqcCount > 0}
									<span class="text-[var(--color-tron-cyan)]">{run.qaqcCount} QA/QC</span>
								{/if}
								{#if run.rejectedCount > 0}
									<span class="text-red-400">{run.rejectedCount} rejected</span>
								{/if}
								<svg class="h-4 w-4 transition-transform text-[var(--color-tron-text-secondary)] {expandedRunId === run.runId ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
								</svg>
							</div>
						</div>
						{#if run.runEndTime}
							<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
								Completed: {new Date(run.runEndTime).toLocaleDateString()} by {run.operatorName ?? 'Unknown'}
							</p>
						{/if}
					</button>

					{#if expandedRunId === run.runId}
						<div class="ml-4 rounded border border-[var(--color-tron-border)]/30 bg-[var(--color-tron-surface)] p-3">
							<div class="flex items-center justify-between">
								<div class="text-xs text-[var(--color-tron-text-secondary)]">
									{run.qaqcCount > 0
										? `${run.qaqcCount} cartridge${run.qaqcCount !== 1 ? 's' : ''} designated for QA/QC`
										: 'No QA/QC cartridges designated'}
								</div>
								{#if run.qaqcCount > 0}
									<button
										type="button"
										onclick={() => startCreateRelease(run.runId)}
										class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-3 py-1.5 text-xs font-medium text-[var(--color-tron-cyan)]"
									>
										Start QA/QC Release
									</button>
								{/if}
							</div>
							{#if run.qaqcCartridgeIds.length > 0}
								<div class="mt-2 flex flex-wrap gap-1">
									{#each run.qaqcCartridgeIds as cId (cId)}
										<span class="rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 px-1.5 py-0.5 font-mono text-xs text-[var(--color-tron-cyan)]">
											{cId}
										</span>
									{/each}
								</div>
							{/if}
						</div>
					{/if}
				{/each}
			</div>
		{/if}
	</div>

	<!-- Shipping Lots -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<h3 class="mb-3 text-sm font-medium text-[var(--color-tron-text)]">Shipping Lots</h3>
		{#if data.lots.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No shipping lots created yet</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-left">
							<th class="px-3 py-2 text-xs font-medium text-[var(--color-tron-text-secondary)]">Lot ID</th>
							<th class="px-3 py-2 text-xs font-medium text-[var(--color-tron-text-secondary)]">Status</th>
							<th class="px-3 py-2 text-xs font-medium text-[var(--color-tron-text-secondary)]">Assay</th>
							<th class="px-3 py-2 text-xs font-medium text-[var(--color-tron-text-secondary)]">Cartridges</th>
							<th class="px-3 py-2 text-xs font-medium text-[var(--color-tron-text-secondary)]">Released</th>
							<th class="px-3 py-2 text-xs font-medium text-[var(--color-tron-text-secondary)]">Created</th>
						</tr>
					</thead>
					<tbody>
						{#each data.lots as lot (lot.id)}
							<tr class="border-b border-[var(--color-tron-border)]/30">
								<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text)]">{lot.id}</td>
								<td class="px-3 py-2">
									<span class="rounded border px-1.5 py-0.5 text-xs font-medium {lotStatusColors[lot.status] ?? ''}">
										{lot.status}
									</span>
								</td>
								<td class="px-3 py-2 text-xs text-[var(--color-tron-text)]">
									{data.assayTypes.find((a) => a.id === lot.assayTypeId)?.name ?? '—'}
								</td>
								<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{lot.cartridgeCount ?? 0}</td>
								<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">
									{lot.releasedAt ? new Date(lot.releasedAt).toLocaleDateString() : '—'}
								</td>
								<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">
									{new Date(lot.createdAt).toLocaleDateString()}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	<!-- Release History -->
	{#if pastReleases.length > 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h3 class="mb-3 text-sm font-medium text-[var(--color-tron-text)]">Release History</h3>
			<div class="space-y-2">
				{#each pastReleases as release (release.id)}
					<div class="flex items-center justify-between rounded border border-[var(--color-tron-border)]/30 p-3">
						<div>
							<span class="font-mono text-sm text-[var(--color-tron-text)]">{release.shippingLotId}</span>
							<span class="ml-2 font-mono text-xs text-[var(--color-tron-text-secondary)]">Run: {release.reagentRunId}</span>
						</div>
						<div class="flex items-center gap-3">
							<span class="rounded border px-1.5 py-0.5 text-xs font-medium {resultColors[release.testResult ?? 'pending']}">
								{release.testResult}
							</span>
							<span class="text-xs text-[var(--color-tron-text-secondary)]">
								{release.testedByName ?? '—'}
							</span>
							{#if release.testedAt}
								<span class="text-xs text-[var(--color-tron-text-secondary)]">
									{new Date(release.testedAt).toLocaleDateString()}
								</span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
