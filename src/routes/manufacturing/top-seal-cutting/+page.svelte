<script lang="ts">
	import { enhance } from '$app/forms';

	interface Run {
		id: string;
		lotBarcode: string;
		expectedSheets: number;
		cutCount: number;
		acceptedCount: number;
		rejectedCount: number;
		operator: string;
		notes: string | null;
		status: string;
		createdAt: string;
	}

	interface Props {
		data: { runs: Run[] };
		form: { success?: boolean; error?: string } | null;
	}

	let { data, form }: Props = $props();

	let lotBarcode = $state('');
	let expectedSheets = $state(0);
	let cutCount = $state(0);
	let acceptedCount = $state(0);
	let notes = $state('');
	let showForm = $state(false);

	const todayRuns = $derived(data.runs.filter((r) => {
		const today = new Date().toISOString().slice(0, 10);
		return r.createdAt.startsWith(today);
	}));
	const todayAccepted = $derived(todayRuns.reduce((sum, r) => sum + r.acceptedCount, 0));
	const todayRejected = $derived(todayRuns.reduce((sum, r) => sum + r.rejectedCount, 0));

	let barcodeInput: HTMLInputElement;

	function onBarcodeKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			const next = document.querySelector<HTMLInputElement>('input[name="expectedSheets"]');
			next?.focus();
		}
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Cut Top Seal</h1>
		<button
			type="button"
			onclick={() => { showForm = !showForm; if (!showForm) { lotBarcode = ''; expectedSheets = 0; cutCount = 0; acceptedCount = 0; notes = ''; } else { setTimeout(() => barcodeInput?.focus(), 100); } }}
			class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20"
		>
			{showForm ? 'Cancel' : '+ Record Cut Run'}
		</button>
	</div>

	{#if form?.success}
		<div class="rounded border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300">Cut run recorded successfully.</div>
	{/if}
	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">{form.error}</div>
	{/if}

	<!-- Today's Stats -->
	<div class="grid grid-cols-3 gap-4">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 text-center">
			<p class="text-2xl font-bold text-[var(--color-tron-cyan)]">{todayRuns.length}</p>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Runs Today</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 text-center">
			<p class="text-2xl font-bold text-green-400">{todayAccepted}</p>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Accepted Today</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 text-center">
			<p class="text-2xl font-bold text-red-400">{todayRejected}</p>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Rejected Today</p>
		</div>
	</div>

	{#if showForm}
		<form
			method="POST"
			action="?/recordRun"
			use:enhance={() => {
				return async ({ update }) => {
					showForm = false;
					lotBarcode = ''; expectedSheets = 0; cutCount = 0; acceptedCount = 0; notes = '';
					await update();
				};
			}}
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5 space-y-4"
		>
			<h3 class="text-sm font-semibold text-[var(--color-tron-cyan)]">Record Top Seal Cut Run</h3>

			<label class="block">
				<span class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Scan Roll/Lot Barcode</span>
				<input
					bind:this={barcodeInput}
					type="text"
					name="lotBarcode"
					bind:value={lotBarcode}
					onkeydown={onBarcodeKeydown}
					class="mt-1 block w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none font-mono"
					placeholder="Scan barcode..."
					autofocus
				/>
			</label>

			{#if lotBarcode}
				<div class="rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 px-3 py-2">
					<p class="text-xs text-[var(--color-tron-text-secondary)]">Roll: <span class="font-mono text-[var(--color-tron-cyan)]">{lotBarcode}</span></p>
				</div>
			{/if}

			<label class="block">
				<span class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Expected Sheets from Roll</span>
				<input type="number" name="expectedSheets" bind:value={expectedSheets} min="1"
					class="mt-1 block w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
			</label>

			<label class="block">
				<span class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Total Cut</span>
				<input type="number" name="cutCount" bind:value={cutCount} min="0"
					class="mt-1 block w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
			</label>

			<label class="block">
				<span class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Accepted</span>
				<input type="number" name="acceptedCount" bind:value={acceptedCount} min="0" max={cutCount}
					class="mt-1 block w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
			</label>

			{#if cutCount > 0}
				<p class="text-xs text-[var(--color-tron-text-secondary)]">
					Rejected: <span class="text-red-400">{cutCount - acceptedCount}</span>
					— Yield: <span class="text-[var(--color-tron-cyan)]">{Math.round((acceptedCount / cutCount) * 100)}%</span>
				</p>
			{/if}

			<label class="block">
				<span class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Notes (optional)</span>
				<textarea name="notes" bind:value={notes} rows="2"
					class="mt-1 block w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
					placeholder="Any issues or observations..."></textarea>
			</label>

			<button type="submit" class="min-h-[44px] w-full rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg)] hover:opacity-90"
				disabled={!lotBarcode}>
				Record Cut Run
			</button>
		</form>
	{/if}

	<!-- Run History -->
	<section>
		<h2 class="mb-3 text-lg font-medium text-[var(--color-tron-cyan)]">Run History ({data.runs.length})</h2>
		{#if data.runs.length === 0}
			<p class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center text-sm text-[var(--color-tron-text-secondary)]">No cutting runs recorded yet.</p>
		{:else}
			<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)]">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
							<th class="px-3 py-2 text-left text-xs font-medium text-[var(--color-tron-text-secondary)]">Date</th>
							<th class="px-3 py-2 text-left text-xs font-medium text-[var(--color-tron-text-secondary)]">Lot</th>
							<th class="px-3 py-2 text-center text-xs font-medium text-[var(--color-tron-text-secondary)]">Expected</th>
							<th class="px-3 py-2 text-center text-xs font-medium text-[var(--color-tron-text-secondary)]">Cut</th>
							<th class="px-3 py-2 text-center text-xs font-medium text-[var(--color-tron-text-secondary)]">Accepted</th>
							<th class="px-3 py-2 text-center text-xs font-medium text-[var(--color-tron-text-secondary)]">Rej</th>
							<th class="px-3 py-2 text-center text-xs font-medium text-[var(--color-tron-text-secondary)]">Yield</th>
							<th class="px-3 py-2 text-left text-xs font-medium text-[var(--color-tron-text-secondary)]">Operator</th>
						</tr>
					</thead>
					<tbody>
						{#each data.runs as run (run.id)}
							<tr class="border-b border-[var(--color-tron-border)]/50 hover:bg-[var(--color-tron-surface)]">
								<td class="px-3 py-2 text-xs text-[var(--color-tron-text)]">
									{new Date(run.createdAt).toLocaleDateString()} {new Date(run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
								</td>
								<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-cyan)]">{run.lotBarcode}</td>
								<td class="px-3 py-2 text-center text-[var(--color-tron-text)]">{run.expectedSheets}</td>
								<td class="px-3 py-2 text-center text-[var(--color-tron-text)]">{run.cutCount}</td>
								<td class="px-3 py-2 text-center text-green-400">{run.acceptedCount}</td>
								<td class="px-3 py-2 text-center text-red-400">{run.rejectedCount}</td>
								<td class="px-3 py-2 text-center text-[var(--color-tron-cyan)]">
									{run.cutCount > 0 ? Math.round((run.acceptedCount / run.cutCount) * 100) : 0}%
								</td>
								<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{run.operator}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>
