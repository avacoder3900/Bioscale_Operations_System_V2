<script lang="ts">
	import { enhance } from '$app/forms';

	interface Release {
		id: string;
		shippingLotId: string;
		reagentRunId: string;
		qaqcCartridgeIds: string[];
		testResult: string | null;
		testedBy: string | null;
		testedAt: string | null;
		notes: string | null;
		createdAt: string;
	}

	interface Props {
		data: {
			releases: Release[];
			filter: string;
		};
		form: { success?: boolean; error?: string } | null;
	}

	let { data, form }: Props = $props();

	let showCreate = $state(false);
	let newShippingLotId = $state('');
	let newReagentRunId = $state('');
	let testingReleaseId = $state<string | null>(null);
	let testCartridgeIds = $state('');
	let resultReleaseId = $state<string | null>(null);
	let resultValue = $state<'passed' | 'failed'>('passed');
	let resultNotes = $state('');

	function statusBadgeClass(status: string | null): string {
		switch (status) {
			case 'passed':
			case 'pass': return 'tron-badge tron-badge-success';
			case 'failed':
			case 'fail': return 'tron-badge tron-badge-error';
			case 'testing': return 'tron-badge tron-badge-warning';
			default: return 'tron-badge tron-badge-neutral';
		}
	}

	function handleResult() {
		return async ({ update }: { update: () => Promise<void> }) => {
			showCreate = false;
			testingReleaseId = null;
			resultReleaseId = null;
			newShippingLotId = '';
			newReagentRunId = '';
			testCartridgeIds = '';
			resultNotes = '';
			await update();
		};
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">QA/QC Release</h1>
		<button
			type="button"
			onclick={() => { showCreate = !showCreate; }}
			class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20"
		>
			{showCreate ? 'Cancel' : '+ New Release'}
		</button>
	</div>

	{#if form?.success}
		<div class="rounded border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300">
			Action completed successfully.
		</div>
	{/if}

	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">
			{form.error}
		</div>
	{/if}

	<!-- Create form -->
	{#if showCreate}
		<form method="POST" action="?/create" use:enhance={handleResult} class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5 space-y-4">
			<h3 class="text-sm font-semibold text-[var(--color-tron-cyan)]">New QA/QC Release</h3>
			<div class="grid gap-4 sm:grid-cols-2">
				<label class="block">
					<span class="tron-label">Shipping Lot ID</span>
					<input type="text" name="shippingLotId" bind:value={newShippingLotId} required class="tron-input" placeholder="e.g. SL-XXXX" />
				</label>
				<label class="block">
					<span class="tron-label">Reagent Run ID</span>
					<input type="text" name="reagentRunId" bind:value={newReagentRunId} required class="tron-input" placeholder="e.g. RGF-XXXX" />
				</label>
			</div>
			<button type="submit" class="tron-btn-primary">Create Release</button>
		</form>
	{/if}

	<!-- Filter tabs -->
	<div class="flex gap-2 text-sm">
		{#each [{ label: 'All', value: 'all' }, { label: 'Pending', value: 'pending' }, { label: 'Testing', value: 'testing' }, { label: 'Passed', value: 'passed' }, { label: 'Failed', value: 'failed' }] as tab (tab.value)}
			<a
				href="?{tab.value === 'all' ? '' : `status=${tab.value}`}"
				class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors {data.filter === tab.value
					? 'bg-[var(--color-tron-cyan)] text-white'
					: 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}"
			>
				{tab.label}
			</a>
		{/each}
	</div>

	<!-- Releases table -->
	{#if data.releases.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-8 text-center">
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No QA/QC releases found.</p>
		</div>
	{:else}
		<div class="space-y-3">
			{#each data.releases as release (release.id)}
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
					<div class="flex items-start justify-between">
						<div>
							<p class="font-mono text-sm font-semibold text-[var(--color-tron-cyan)]">{release.id}</p>
							<div class="mt-1 flex items-center gap-4 text-xs text-[var(--color-tron-text-secondary)]">
								<span>Lot: <span class="font-mono text-[var(--color-tron-text)]">{release.shippingLotId}</span></span>
								<span>Run: <span class="font-mono text-[var(--color-tron-text)]">{release.reagentRunId}</span></span>
								<span>{new Date(release.createdAt).toLocaleDateString()}</span>
							</div>
						</div>
						<span class={statusBadgeClass(release.testResult)}>
							{release.testResult ?? 'pending'}
						</span>
					</div>

					{#if release.qaqcCartridgeIds.length > 0}
						<div class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
							Sample cartridges: {release.qaqcCartridgeIds.length}
						</div>
					{/if}

					{#if release.notes}
						<p class="mt-2 rounded bg-[var(--color-tron-bg)] px-3 py-2 text-xs text-[var(--color-tron-text)]">{release.notes}</p>
					{/if}

					<!-- Actions based on status -->
					<div class="mt-3 flex gap-2">
						{#if release.testResult === 'pending'}
							{#if testingReleaseId === release.id}
								<form method="POST" action="?/startTesting" use:enhance={handleResult} class="flex flex-1 items-end gap-2">
									<input type="hidden" name="releaseId" value={release.id} />
									<label class="flex-1 block">
										<span class="text-xs text-[var(--color-tron-text-secondary)]">Sample Cartridge IDs (comma-separated)</span>
										<input type="text" bind:value={testCartridgeIds} class="tron-input text-sm" placeholder="CART-001, CART-002" />
										<input type="hidden" name="cartridgeIds" value={JSON.stringify(testCartridgeIds.split(',').map(s => s.trim()).filter(Boolean))} />
									</label>
									<button type="submit" class="min-h-[44px] rounded border border-amber-500/50 bg-amber-900/20 px-3 py-2 text-xs text-amber-300 hover:bg-amber-900/30">Start</button>
									<button type="button" onclick={() => { testingReleaseId = null; }} class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">Cancel</button>
								</form>
							{:else}
								<button
									type="button"
									onclick={() => { testingReleaseId = release.id; }}
									class="rounded border border-amber-500/50 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-900/20"
								>
									Start Testing
								</button>
							{/if}
						{:else if release.testResult === 'testing'}
							{#if resultReleaseId === release.id}
								<form method="POST" action="?/recordResult" use:enhance={handleResult} class="flex flex-1 items-end gap-2">
									<input type="hidden" name="releaseId" value={release.id} />
									<select name="result" bind:value={resultValue} class="tron-select text-sm" style="width:120px">
										<option value="passed">Passed</option>
										<option value="failed">Failed</option>
									</select>
									<label class="flex-1 block">
										<input type="text" name="notes" bind:value={resultNotes} class="tron-input text-sm" placeholder="Notes (optional)" />
									</label>
									<button type="submit" class="min-h-[44px] rounded border border-green-500/50 bg-green-900/20 px-3 py-2 text-xs text-green-300 hover:bg-green-900/30">Record</button>
									<button type="button" onclick={() => { resultReleaseId = null; }} class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">Cancel</button>
								</form>
							{:else}
								<button
									type="button"
									onclick={() => { resultReleaseId = release.id; }}
									class="rounded border border-green-500/50 px-3 py-1.5 text-xs text-green-300 hover:bg-green-900/20"
								>
									Record Result
								</button>
							{/if}
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
