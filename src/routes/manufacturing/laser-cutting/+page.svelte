<script lang="ts">
	import { enhance } from '$app/forms';

	interface Batch {
		batchId: string;
		inputSheetCount: number;
		outputSheetCount: number;
		failureCount: number;
		failureNotes: string | null;
		cuttingProgramLink: string | null;
		toolsUsed: string | null;
		operatorId: string;
		operatorName: string;
		createdAt: string;
	}

	interface Stats {
		totalBatches: number;
		totalInput: number;
		totalOutput: number;
		totalFailures: number;
		failureRate: number;
	}

	interface Defaults {
		defaultLaserTools: string | null;
		defaultCuttingProgramLink: string | null;
	}

	interface InventoryItem {
		name: string;
		quantity: number;
		unit: string;
	}

	interface Props {
		data: { batches: Batch[]; stats: Stats; defaults: Defaults; inventory: { laserCutSheets: InventoryItem } };
		form: { success?: boolean; defaultsSaved?: boolean; error?: string } | null;
	}

	let { data, form }: Props = $props();

	let showRecord = $state(false);
	let showDefaults = $state(false);
	let inputCount = $state(10);
	let failureCount = $state(0);
	let failureNotes = $state('');

	// Auto-fill from saved defaults
	let cuttingProgramLink = $state(data.defaults.defaultCuttingProgramLink ?? '');
	let toolsUsed = $state(data.defaults.defaultLaserTools ?? '');

	// Default settings form values
	let defaultTools = $state(data.defaults.defaultLaserTools ?? '');
	let defaultUrl = $state(data.defaults.defaultCuttingProgramLink ?? '');

	const outputCount = $derived(Math.max(0, inputCount - failureCount));
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Laser Cut Thermoseal</h1>
		<div class="flex gap-2">
			<button
				type="button"
				onclick={() => { showDefaults = !showDefaults; }}
				class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-2 text-sm font-medium text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]/50 hover:text-[var(--color-tron-cyan)]"
			>
				{showDefaults ? 'Hide Settings' : 'Settings'}
			</button>
			<button
				type="button"
				onclick={() => { showRecord = !showRecord; }}
				class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20"
			>
				{showRecord ? 'Cancel' : '+ Record Batch'}
			</button>
		</div>
	</div>

	{#if form?.success}
		<div class="rounded border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300">Batch recorded.</div>
	{/if}
	{#if form?.defaultsSaved}
		<div class="rounded border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300">Default settings saved.</div>
	{/if}
	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">{form.error}</div>
	{/if}

	<!-- Default Settings Panel -->
	{#if showDefaults}
		<form
			method="POST"
			action="?/saveDefaults"
			use:enhance={() => {
				return async ({ update }) => {
					await update();
				};
			}}
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5 space-y-4"
		>
			<h3 class="text-sm font-semibold text-[var(--color-tron-cyan)]">Default Settings</h3>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">These values auto-fill into every new batch.</p>
			<div class="grid gap-4 sm:grid-cols-2">
				<label class="block">
					<span class="tron-label">Default Tools</span>
					<input type="text" name="defaultLaserTools" bind:value={defaultTools} class="tron-input" placeholder="e.g. Epilog Zing 24" />
				</label>
				<label class="block">
					<span class="tron-label">Default Cutting Program URL</span>
					<input type="text" name="defaultCuttingProgramLink" bind:value={defaultUrl} class="tron-input" placeholder="URL or path to cutting program..." />
				</label>
			</div>
			<button type="submit" class="tron-btn-primary">Save Defaults</button>
		</form>
	{/if}

	<!-- Inventory -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Output: {data.inventory.laserCutSheets.name}</p>
		<p class="mt-1 text-2xl font-bold text-[var(--color-tron-text)]">
			{data.inventory.laserCutSheets.quantity}
			<span class="text-sm font-normal text-[var(--color-tron-text-secondary)]">{data.inventory.laserCutSheets.unit}</span>
		</p>
	</div>

	<!-- Stats -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Batches</p>
			<p class="text-xl font-bold text-[var(--color-tron-cyan)]">{data.stats.totalBatches}</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Total Input</p>
			<p class="text-xl font-bold text-[var(--color-tron-text)]">{data.stats.totalInput}</p>
		</div>
		<div class="rounded-lg border border-green-500/30 bg-green-900/10 px-3 py-2 text-center">
			<p class="text-xs text-green-400/70">Output</p>
			<p class="text-xl font-bold text-green-400">{data.stats.totalOutput}</p>
		</div>
		<div class="rounded-lg border border-red-500/30 bg-red-900/10 px-3 py-2 text-center">
			<p class="text-xs text-red-400/70">Total Failures</p>
			<p class="text-xl font-bold text-red-400">{data.stats.totalFailures}</p>
		</div>
		<div class="rounded-lg border border-red-500/30 bg-red-900/10 px-3 py-2 text-center">
			<p class="text-xs text-red-400/70">Failure Rate</p>
			<p class="text-xl font-bold text-red-400">{(data.stats.failureRate * 100).toFixed(1)}%</p>
		</div>
	</div>

	<!-- Record batch form -->
	{#if showRecord}
		<form
			method="POST"
			action="?/recordBatch"
			use:enhance={() => {
				return async ({ update }) => {
					showRecord = false;
					inputCount = 10;
					failureCount = 0;
					failureNotes = '';
					cuttingProgramLink = data.defaults.defaultCuttingProgramLink ?? '';
					toolsUsed = data.defaults.defaultLaserTools ?? '';
					await update();
				};
			}}
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5 space-y-4"
		>
			<h3 class="text-sm font-semibold text-[var(--color-tron-cyan)]">Record Laser Cut Batch</h3>
			<div class="grid gap-4 sm:grid-cols-3">
				<label class="block">
					<span class="tron-label">Input Strips</span>
					<input type="number" name="inputSheetCount" bind:value={inputCount} min="1" max="500" required class="tron-input" />
				</label>
				<label class="block">
					<span class="tron-label">Failures</span>
					<input type="number" name="failureCount" bind:value={failureCount} min="0" max={inputCount} class="tron-input" />
				</label>
				<div>
					<span class="tron-label">Output Sheets</span>
					<p class="mt-2 text-xl font-bold text-green-400">{outputCount}</p>
				</div>
			</div>
			{#if failureCount > 0}
				<label class="block">
					<span class="tron-label">Failure Notes</span>
					<input type="text" name="failureNotes" bind:value={failureNotes} class="tron-input" placeholder="Describe failures..." />
				</label>
			{/if}
			<div class="grid gap-4 sm:grid-cols-2">
				<label class="block">
					<span class="tron-label">Cutting Program Link</span>
					<input type="text" name="cuttingProgramLink" bind:value={cuttingProgramLink} class="tron-input" placeholder="URL or path..." />
					{#if data.defaults.defaultCuttingProgramLink && cuttingProgramLink === data.defaults.defaultCuttingProgramLink}
						<span class="text-xs text-[var(--color-tron-text-secondary)] italic">auto-filled from defaults</span>
					{/if}
				</label>
				<label class="block">
					<span class="tron-label">Tools Used</span>
					<input type="text" name="toolsUsed" bind:value={toolsUsed} class="tron-input" placeholder="e.g. Epilog Zing 24" />
					{#if data.defaults.defaultLaserTools && toolsUsed === data.defaults.defaultLaserTools}
						<span class="text-xs text-[var(--color-tron-text-secondary)] italic">auto-filled from defaults</span>
					{/if}
				</label>
			</div>
			<button type="submit" class="tron-btn-primary">Record Batch</button>
		</form>
	{/if}

	<!-- Batch history -->
	{#if data.batches.length > 0}
		<section>
			<h2 class="mb-3 text-lg font-medium text-[var(--color-tron-cyan)]">Batch History</h2>
			<div class="overflow-x-auto">
				<table class="tron-table w-full text-sm">
					<thead>
						<tr>
							<th>Batch</th>
							<th>Operator</th>
							<th>Input</th>
							<th>Output</th>
							<th>Failures</th>
							<th>Tools</th>
							<th>Program</th>
							<th>Notes</th>
							<th>Date</th>
						</tr>
					</thead>
					<tbody>
						{#each data.batches as batch (batch.batchId)}
							<tr>
								<td class="font-mono text-[var(--color-tron-cyan)]">{batch.batchId}</td>
								<td class="text-[var(--color-tron-text)]">{batch.operatorName}</td>
								<td>{batch.inputSheetCount}</td>
								<td class="text-green-400">{batch.outputSheetCount}</td>
								<td class={batch.failureCount > 0 ? 'text-red-400 font-semibold' : 'text-[var(--color-tron-text-secondary)]'}>
									{batch.failureCount}
								</td>
								<td class="max-w-[150px] truncate text-[var(--color-tron-text-secondary)]">{batch.toolsUsed ?? '-'}</td>
								<td class="max-w-[150px] truncate">
									{#if batch.cuttingProgramLink}
										<!-- eslint-disable svelte/no-navigation-without-resolve -->
										<a href={batch.cuttingProgramLink} target="_blank" rel="noopener noreferrer" class="text-[var(--color-tron-cyan)] underline hover:text-[var(--color-tron-cyan)]/80">
											Link
										</a>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
									{:else}
										<span class="text-[var(--color-tron-text-secondary)]">-</span>
									{/if}
								</td>
								<td class="max-w-[200px] truncate text-[var(--color-tron-text-secondary)]">{batch.failureNotes ?? '-'}</td>
								<td class="whitespace-nowrap text-[var(--color-tron-text-secondary)]">{new Date(batch.createdAt).toLocaleDateString()}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{:else}
		<p class="text-center text-sm text-[var(--color-tron-text-secondary)]">No batches recorded yet.</p>
	{/if}
</div>
