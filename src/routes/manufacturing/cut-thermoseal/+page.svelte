<script lang="ts">
	import { enhance } from '$app/forms';

	interface Run {
		id: string;
		lotBarcode: string;
		expectedSheets: number;
		acceptedCount: number;
		rejectedCount: number;
		operator: string;
		notes: string | null;
		createdAt: string;
	}

	interface Props {
		data: { runs: Run[] };
		form: { success?: boolean; error?: string } | null;
	}

	let { data, form }: Props = $props();

	// Multi-step state
	let step = $state<'idle' | 'scanned' | 'record'>('idle');
	let lotBarcode = $state('');
	let expectedSheets = $state(0);
	let acceptedCount = $state(0);
	let notes = $state('');

	let barcodeInput: HTMLInputElement;

	// Known roll yields (sheets per roll) — extend as needed
	const rollYields: Record<string, number> = {
		// Default if not in map — operator enters manually
	};

	const todayRuns = $derived(data.runs.filter((r) => {
		const today = new Date().toISOString().slice(0, 10);
		return r.createdAt.startsWith(today);
	}));
	const todayAccepted = $derived(todayRuns.reduce((sum, r) => sum + r.acceptedCount, 0));

	function onBarcodeScan(e: KeyboardEvent) {
		if (e.key === 'Enter' && lotBarcode.trim()) {
			e.preventDefault();
			// Look up expected yield or let operator enter
			const known = rollYields[lotBarcode.trim()];
			if (known) expectedSheets = known;
			step = 'scanned';
		}
	}

	function startNew() {
		step = 'idle';
		lotBarcode = '';
		expectedSheets = 0;
		acceptedCount = 0;
		notes = '';
		setTimeout(() => barcodeInput?.focus(), 100);
	}

	// After successful form submission, reset
	$effect(() => {
		if (form?.success) {
			step = 'idle';
			lotBarcode = '';
			expectedSheets = 0;
			acceptedCount = 0;
			notes = '';
		}
	});
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Cut Thermoseal</h1>
		{#if step !== 'idle'}
			<button type="button" onclick={startNew}
				class="min-h-[44px] rounded border border-red-500/50 bg-red-900/10 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-900/20">
				Cancel
			</button>
		{/if}
	</div>

	{#if form?.success}
		<div class="rounded border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300">
			✓ Cut run recorded. <button type="button" onclick={startNew} class="underline hover:text-green-200">Start another</button>
		</div>
	{/if}
	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">{form.error}</div>
	{/if}

	<!-- Today's Stats -->
	<div class="grid grid-cols-2 gap-4">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 text-center">
			<p class="text-2xl font-bold text-[var(--color-tron-cyan)]">{todayRuns.length}</p>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Runs Today</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 text-center">
			<p class="text-2xl font-bold text-green-400">{todayAccepted}</p>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Strips Accepted Today</p>
		</div>
	</div>

	<!-- STEP 1: Scan Barcode -->
	{#if step === 'idle'}
		<div class="rounded-lg border-2 border-dashed border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-surface)] p-8 text-center space-y-4">
			<div class="text-4xl">📦</div>
			<h2 class="text-lg font-semibold text-[var(--color-tron-cyan)]">Scan Thermoseal Roll Barcode</h2>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">Scan or type the roll barcode to begin tracking this cutting run.</p>
			<input
				bind:this={barcodeInput}
				type="text"
				bind:value={lotBarcode}
				onkeydown={onBarcodeScan}
				class="mx-auto block w-full max-w-md rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-bg)] px-4 py-3 text-center font-mono text-lg text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
				placeholder="Scan barcode..."
				autofocus
			/>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Press Enter after scanning</p>
		</div>
	{/if}

	<!-- STEP 2: Scanned — Enter expected + accepted -->
	{#if step === 'scanned'}
		<form
			method="POST"
			action="?/recordRun"
			use:enhance
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5 space-y-5"
		>
			<input type="hidden" name="lotBarcode" value={lotBarcode} />

			<!-- Roll info banner -->
			<div class="rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 px-4 py-3 flex items-center justify-between">
				<div>
					<p class="text-xs text-[var(--color-tron-text-secondary)]">Roll Barcode</p>
					<p class="font-mono text-lg font-bold text-[var(--color-tron-cyan)]">{lotBarcode}</p>
				</div>
				<span class="rounded bg-[var(--color-tron-cyan)]/20 px-2 py-1 text-xs font-medium text-[var(--color-tron-cyan)]">Scanned ✓</span>
			</div>

			<label class="block">
				<span class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Expected Strips from this Roll</span>
				<input type="number" name="expectedSheets" bind:value={expectedSheets} min="1"
					class="mt-1 block w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
					autofocus />
				<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">How many strips should this roll produce?</p>
			</label>

			<label class="block">
				<span class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Accepted Strips</span>
				<input type="number" name="acceptedCount" bind:value={acceptedCount} min="0"
					class="mt-1 block w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
			</label>

			{#if expectedSheets > 0 && acceptedCount >= 0}
				<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-3 grid grid-cols-3 gap-3 text-center">
					<div>
						<p class="text-lg font-bold text-[var(--color-tron-text)]">{expectedSheets}</p>
						<p class="text-xs text-[var(--color-tron-text-secondary)]">Expected</p>
					</div>
					<div>
						<p class="text-lg font-bold text-green-400">{acceptedCount}</p>
						<p class="text-xs text-[var(--color-tron-text-secondary)]">Accepted</p>
					</div>
					<div>
						<p class="text-lg font-bold text-red-400">{expectedSheets - acceptedCount}</p>
						<p class="text-xs text-[var(--color-tron-text-secondary)]">Rejected</p>
					</div>
				</div>
				{#if expectedSheets > 0}
					<p class="text-center text-sm">
						Yield: <span class="font-bold text-[var(--color-tron-cyan)]">{Math.round((acceptedCount / expectedSheets) * 100)}%</span>
					</p>
				{/if}
			{/if}

			<label class="block">
				<span class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Notes (optional)</span>
				<textarea name="notes" bind:value={notes} rows="2"
					class="mt-1 block w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
					placeholder="Any issues or observations..."></textarea>
			</label>

			<button type="submit"
				class="min-h-[44px] w-full rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg)] hover:opacity-90"
				disabled={!lotBarcode || expectedSheets <= 0}>
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
							<th class="px-3 py-2 text-left text-xs font-medium text-[var(--color-tron-text-secondary)]">Roll</th>
							<th class="px-3 py-2 text-center text-xs font-medium text-[var(--color-tron-text-secondary)]">Expected</th>
							<th class="px-3 py-2 text-center text-xs font-medium text-[var(--color-tron-text-secondary)]">Accepted</th>
							<th class="px-3 py-2 text-center text-xs font-medium text-[var(--color-tron-text-secondary)]">Rejected</th>
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
								<td class="px-3 py-2 text-center text-green-400">{run.acceptedCount}</td>
								<td class="px-3 py-2 text-center text-red-400">{run.rejectedCount}</td>
								<td class="px-3 py-2 text-center text-[var(--color-tron-cyan)]">
									{run.expectedSheets > 0 ? Math.round((run.acceptedCount / run.expectedSheets) * 100) : 0}%
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
