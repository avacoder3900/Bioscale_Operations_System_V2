<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';
	import SpuStatusBadge from '$lib/components/spu/SpuStatusBadge.svelte';
	import ScanInput from '$lib/components/assembly/ScanInput.svelte';

	let { data, form } = $props();

	type Row = {
		id: string;
		udi: string;
		barcode: string | null;
		status: string;
		assemblyStatus: string | null;
		batchNumber: string | null;
		customerName: string | null;
		finalized: boolean;
		createdAt: string | null;
		updatedAt: string | null;
	};

	let filter = $state<'unassigned' | 'assigned' | 'all'>('unassigned');
	let search = $state('');

	/** The SPU currently staged in the pairing panel. */
	let selectedSpuId = $state<string | null>(null);
	/** QR payload captured by the second scan, not yet committed. */
	let pendingBarcode = $state('');
	let reason = $state('');
	/** Auto-commit a clean first assignment so a two-scan pair needs zero clicks. */
	let rapidMode = $state(true);
	let submitting = $state(false);
	/** Client-side scan resolution failure — distinct from a server-side `form.error`. */
	let scanError = $state('');
	/**
	 * ScanInput pulls focus back on blur, which is right for a bench scanner and
	 * wrong for the reason textarea sharing the page. Pause it while a real
	 * field holds focus.
	 */
	let scanPaused = $state(false);
	/** What this sitting has bound, newest first. Survives until reload. */
	let sessionLog = $state<{ udi: string; barcode: string; previous: string | null }[]>([]);

	let assignForm = $state<HTMLFormElement | undefined>();

	const rows = $derived(data.rows as Row[]);
	const selectedSpu = $derived(rows.find((r) => r.id === selectedSpuId) ?? null);
	/** Step 1 = identify the unit, step 2 = read its label. */
	const step = $derived(selectedSpu ? 2 : 1);
	/** An overwrite is never auto-committed, and always needs a typed reason. */
	const isOverwrite = $derived(Boolean(selectedSpu?.barcode));

	const visibleRows = $derived(
		rows
			.filter((r) => (filter === 'all' ? true : filter === 'assigned' ? !!r.barcode : !r.barcode))
			.filter((r) => {
				const q = search.trim().toLowerCase();
				if (!q) return true;
				return (
					r.udi.toLowerCase().includes(q) ||
					(r.barcode ?? '').toLowerCase().includes(q) ||
					(r.batchNumber ?? '').toLowerCase().includes(q) ||
					(r.customerName ?? '').toLowerCase().includes(q)
				);
			})
	);

	/** Resolve a scanned code against the already-loaded roster — no round trip. */
	function resolveSpu(code: string): Row | null {
		const c = code.trim().toLowerCase();
		if (!c) return null;
		return (
			rows.find((r) => r.udi.toLowerCase() === c) ??
			rows.find((r) => (r.barcode ?? '').toLowerCase() === c) ??
			rows.find((r) => r.id.toLowerCase() === c) ??
			null
		);
	}

	function handleScan(value: string) {
		scanError = '';
		const code = value.trim();
		if (!code) return;

		if (step === 1) {
			const hit = resolveSpu(code);
			if (!hit) {
				scanError = `No SPU matches "${code}". Scan the unit's UDI label, or pick it from the table.`;
				return;
			}
			if (hit.finalized) {
				scanError = `${hit.udi} is finalized — its barcode cannot be changed here.`;
				return;
			}
			selectedSpuId = hit.id;
			return;
		}

		// Step 2 — this scan is the QR label being bound to the staged SPU.
		pendingBarcode = code;

		const clash = rows.find((r) => (r.barcode ?? '').toLowerCase() === code.toLowerCase());
		if (clash && clash.id !== selectedSpuId) {
			scanError = `That label is already bound to ${clash.udi}. Scan a different label.`;
			pendingBarcode = '';
			return;
		}

		if (rapidMode && !isOverwrite) {
			assignForm?.requestSubmit();
		}
	}

	function stage(row: Row) {
		if (row.finalized) return;
		selectedSpuId = row.id;
		pendingBarcode = '';
		reason = '';
		scanError = '';
	}

	function resetPair() {
		selectedSpuId = null;
		pendingBarcode = '';
		reason = '';
		scanError = '';
	}

	const submitAssign = () => {
		submitting = true;
		return async ({ result, update }: any) => {
			submitting = false;
			if (result.type === 'success' && result.data?.assigned) {
				const a = result.data.assigned;
				sessionLog = [
					{ udi: a.udi, barcode: a.barcode, previous: a.previous },
					...sessionLog
				].slice(0, 50);
				resetPair();
				// Reruns load so the table and counts reflect the new binding.
				await update({ reset: true });
			} else {
				await update({ reset: false });
			}
		};
	};

	function shortDate(iso: string | null): string {
		if (!iso) return '—';
		return new Date(iso).toLocaleDateString();
	}
</script>

<svelte:head><title>SPU Barcodes | BIMS</title></svelte:head>

<div class="space-y-6">
	<!-- Header + coverage -->
	<div class="flex flex-wrap items-end justify-between gap-4">
		<div>
			<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Barcode Assignment</h1>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				Bind a scanned QR label to an SPU. Scan the unit, scan its label.
			</p>
		</div>
		<div class="flex gap-3">
			<div class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-center">
				<div class="text-2xl font-bold text-[var(--color-tron-text-primary)]">
					{data.counts.total}
				</div>
				<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Total SPUs</div>
			</div>
			<div class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-center">
				<div class="text-2xl font-bold text-[var(--color-tron-cyan)]">{data.counts.assigned}</div>
				<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Assigned</div>
			</div>
			<div class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-center">
				<div
					class="text-2xl font-bold {data.counts.unassigned > 0
						? 'text-[var(--color-tron-orange)]'
						: 'text-[var(--color-tron-text-primary)]'}"
				>
					{data.counts.unassigned}
				</div>
				<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Unassigned</div>
			</div>
		</div>
	</div>

	<div class="grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
		<!-- Pairing panel -->
		<div class="space-y-4">
			<TronCard>
				<div class="mb-3 flex items-center justify-between">
					<h2 class="text-sm font-bold uppercase text-[var(--color-tron-cyan)]">Pair a label</h2>
					<label class="flex items-center gap-2 text-xs text-[var(--color-tron-text-secondary)]">
						<input type="checkbox" bind:checked={rapidMode} />
						Rapid mode
					</label>
				</div>

				<!-- Step rail -->
				<div class="mb-4 flex items-center gap-2 text-xs">
					<span
						class="rounded px-2 py-1 {step === 1
							? 'bg-[var(--color-tron-cyan)] font-bold text-black'
							: 'text-[var(--color-tron-text-secondary)]'}">1 · Scan SPU</span
					>
					<span class="text-[var(--color-tron-text-secondary)]">→</span>
					<span
						class="rounded px-2 py-1 {step === 2
							? 'bg-[var(--color-tron-cyan)] font-bold text-black'
							: 'text-[var(--color-tron-text-secondary)]'}">2 · Scan QR label</span
					>
				</div>

				<ScanInput
					label={step === 1 ? 'Scan SPU (UDI)' : 'Scan QR label'}
					placeholder={step === 1 ? 'Scan or type UDI…' : 'Scan the QR label…'}
					onScan={handleScan}
					disabled={scanPaused || submitting}
				/>

				{#if scanError}
					<p class="mt-2 text-sm text-[var(--color-tron-red)]">{scanError}</p>
				{/if}
				{#if form?.error}
					<p class="mt-2 text-sm text-[var(--color-tron-red)]">{form.error}</p>
				{/if}

				{#if selectedSpu}
					<div class="mt-4 rounded border border-[var(--color-tron-cyan)] p-3">
						<div class="flex items-center justify-between gap-2">
							<span class="font-mono text-sm font-bold text-[var(--color-tron-cyan)]"
								>{selectedSpu.udi}</span
							>
							<SpuStatusBadge status={selectedSpu.status} />
						</div>

						<dl class="mt-3 space-y-1 text-xs">
							<div class="flex justify-between gap-2">
								<dt class="text-[var(--color-tron-text-secondary)]">Current barcode</dt>
								<dd class="font-mono break-all text-right">
									{#if selectedSpu.barcode}
										<span class="text-[var(--color-tron-orange)]">{selectedSpu.barcode}</span>
									{:else}
										<span class="text-[var(--color-tron-text-secondary)]">none</span>
									{/if}
								</dd>
							</div>
							{#if selectedSpu.batchNumber}
								<div class="flex justify-between gap-2">
									<dt class="text-[var(--color-tron-text-secondary)]">Batch</dt>
									<dd>{selectedSpu.batchNumber}</dd>
								</div>
							{/if}
							{#if selectedSpu.customerName}
								<div class="flex justify-between gap-2">
									<dt class="text-[var(--color-tron-text-secondary)]">Customer</dt>
									<dd>{selectedSpu.customerName}</dd>
								</div>
							{/if}
							<div class="flex justify-between gap-2">
								<dt class="text-[var(--color-tron-text-secondary)]">Created</dt>
								<dd>{shortDate(selectedSpu.createdAt)}</dd>
							</div>
						</dl>

						<form method="POST" action="?/assign" use:enhance={submitAssign} bind:this={assignForm}>
							<input type="hidden" name="spuId" value={selectedSpu.id} />
							<input type="hidden" name="barcode" value={pendingBarcode} />

							<div class="mt-3">
								<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">
									New barcode
								</div>
								<div class="mt-1 font-mono text-sm break-all">
									{#if pendingBarcode}
										<span class="text-[var(--color-tron-cyan)]">{pendingBarcode}</span>
									{:else}
										<span class="text-[var(--color-tron-text-secondary)]">awaiting scan…</span>
									{/if}
								</div>
							</div>

							{#if isOverwrite}
								<div class="mt-3">
									<label
										for="reason"
										class="text-xs font-bold uppercase text-[var(--color-tron-orange)]"
									>
										Reason for re-assignment (required)
									</label>
									<textarea
										id="reason"
										name="reason"
										bind:value={reason}
										onfocusin={() => (scanPaused = true)}
										onfocusout={() => (scanPaused = false)}
										rows="2"
										placeholder="e.g. original label damaged during servicing"
										class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-transparent px-2 py-1 text-sm"
									></textarea>
									<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
										This SPU already has a barcode. The change is logged old → new.
									</p>
								</div>
							{/if}

							<div class="mt-3 flex gap-2">
								<TronButton
									type="submit"
									variant="primary"
									disabled={!pendingBarcode ||
										submitting ||
										(isOverwrite && reason.trim().length < 3)}
								>
									{submitting ? 'Saving…' : isOverwrite ? 'Re-assign barcode' : 'Assign barcode'}
								</TronButton>
								<TronButton type="button" variant="ghost" onclick={resetPair}>Cancel</TronButton>
							</div>
						</form>
					</div>
				{/if}
			</TronCard>

			{#if sessionLog.length > 0}
				<TronCard>
					<h2 class="mb-3 text-sm font-bold uppercase text-[var(--color-tron-cyan)]">
						This session ({sessionLog.length})
					</h2>
					<ul class="space-y-2 text-xs">
						{#each sessionLog as entry, i (i)}
							<li class="border-b border-[var(--color-tron-border)] pb-2 last:border-0">
								<div class="font-mono font-bold text-[var(--color-tron-cyan)]">{entry.udi}</div>
								<div class="font-mono break-all text-[var(--color-tron-text-secondary)]">
									{#if entry.previous}
										<span class="line-through">{entry.previous}</span> →
									{/if}
									{entry.barcode}
								</div>
							</li>
						{/each}
					</ul>
				</TronCard>
			{/if}
		</div>

		<!-- Roster -->
		<TronCard>
			<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
				<div class="flex gap-1">
					{#each [['unassigned', `Unassigned (${data.counts.unassigned})`], ['assigned', `Assigned (${data.counts.assigned})`], ['all', `All (${data.counts.total})`]] as [key, label] (key)}
						<button
							type="button"
							onclick={() => (filter = key as typeof filter)}
							class="rounded px-3 py-1 text-xs transition-colors {filter === key
								? 'bg-[var(--color-tron-cyan)] font-bold text-black'
								: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}"
						>
							{label}
						</button>
					{/each}
				</div>
				<input
					type="search"
					bind:value={search}
					onfocusin={() => (scanPaused = true)}
					onfocusout={() => (scanPaused = false)}
					placeholder="Filter by UDI, barcode, batch…"
					class="rounded border border-[var(--color-tron-border)] bg-transparent px-3 py-1 text-sm"
				/>
			</div>

			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-left">
							<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">UDI</th>
							<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]"
								>Barcode</th
							>
							<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]"
								>Status</th
							>
							<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]"
								>Batch</th
							>
							<th class="py-2 text-right text-xs uppercase text-[var(--color-tron-text-secondary)]"
								>Action</th
							>
						</tr>
					</thead>
					<tbody>
						{#each visibleRows as row (row.id)}
							<tr
								class="border-b border-[var(--color-tron-border)] last:border-0 {selectedSpuId ===
								row.id
									? 'bg-[var(--color-tron-bg-secondary)]'
									: ''}"
							>
								<td class="py-2 pr-4 font-mono text-[var(--color-tron-cyan)]">{row.udi}</td>
								<td class="py-2 pr-4 font-mono text-xs break-all">
									{#if row.barcode}
										{row.barcode}
									{:else}
										<span class="text-[var(--color-tron-orange)]">— none —</span>
									{/if}
								</td>
								<td class="py-2 pr-4"><SpuStatusBadge status={row.status} /></td>
								<td class="py-2 pr-4 text-xs text-[var(--color-tron-text-secondary)]"
									>{row.batchNumber ?? '—'}</td
								>
								<td class="py-2 text-right">
									{#if row.finalized}
										<TronBadge variant="neutral">finalized</TronBadge>
									{:else}
										<TronButton variant="ghost" onclick={() => stage(row)}>
											{row.barcode ? 'Change' : 'Assign'}
										</TronButton>
									{/if}
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="5" class="py-8 text-center text-[var(--color-tron-text-secondary)]">
									No SPUs match this filter.
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</TronCard>
	</div>
</div>
