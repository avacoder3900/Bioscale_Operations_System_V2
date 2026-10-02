<script lang="ts">
	interface ReagentDef {
		wellPosition: number;
		reagentName: string;
		isActive: boolean;
	}

	interface TubeRecord {
		wellPosition: number;
		reagentName: string;
		sourceLotId: string;
		transferTubeId: string;
	}

	/** A research-app reagent lot (reagent_set_lots): the bundle of inventory barcodes being filled. */
	interface ReagentLotOption {
		_id: string;
		lotNumber: string;
		name?: string;
		assayId?: string;
		createdAt?: string;
		components?: { role: string; catalogName?: string; manufacturerLotId?: string }[];
	}

	interface Props {
		reagentDefinitions: ReagentDef[];
		reagentLots: ReagentLotOption[];
		onComplete: (tubes: TubeRecord[], reagentLotId: string) => void;
		onSaveNote?: (noteBody: string) => Promise<{ ok: boolean; error?: string; cartridgeCount?: number }>;
		readonly?: boolean;
		cartridgeCount?: number;
	}

	let { reagentDefinitions, reagentLots, onComplete, onSaveNote, readonly: isReadonly = false, cartridgeCount = 0 }: Props = $props();

	// Operator-entered batch note — saved against every cartridge currently
	// loaded on the run via the recordBatchNote action.
	let noteBody = $state('');
	let noteSaving = $state(false);
	let noteError = $state('');
	let noteSavedAt = $state<Date | null>(null);
	let noteSavedCount = $state(0);

	async function saveNote() {
		if (!onSaveNote || !noteBody.trim() || noteSaving) return;
		noteSaving = true;
		noteError = '';
		try {
			const result = await onSaveNote(noteBody.trim());
			if (!result.ok) {
				noteError = result.error ?? 'Failed to save note';
			} else {
				noteSavedAt = new Date();
				noteSavedCount = result.cartridgeCount ?? 0;
			}
		} catch (e) {
			noteError = e instanceof Error ? e.message : 'Failed to save note';
		} finally {
			noteSaving = false;
		}
	}

	let selectedLotId = $state('');
	let submitting = $state(false);

	const activeWells = $derived(
		reagentDefinitions.filter((d) => d.isActive).sort((a, b) => a.wellPosition - b.wellPosition)
	);
	const selectedLot = $derived(reagentLots.find((l) => l._id === selectedLotId) ?? null);
	const critical = (lot: ReagentLotOption, role: string) => lot.components?.find((c) => c.role === role);
	const describe = (lot: ReagentLotOption) =>
		['qd630', 'qd480', 'beads']
			.map((r) => { const c = critical(lot, r); return c ? `${r}: ${c.catalogName ?? '?'}${c.manufacturerLotId ? ` (${c.manufacturerLotId})` : ''}` : `${r}: –`; })
			.join(' · ');

	// Every well of this fill carries the reagent lot number; the transfer tube id is
	// derived so downstream views keep a per-well record.
	const tubes = $derived<TubeRecord[]>(
		selectedLot
			? activeWells.map((w, i) => ({ wellPosition: w.wellPosition, reagentName: w.reagentName, sourceLotId: selectedLot.lotNumber, transferTubeId: `${selectedLot.lotNumber}-T${i + 1}` }))
			: []
	);

	function handleSubmit() {
		if (submitting || !selectedLot) return;
		submitting = true;
		onComplete(tubes, selectedLot._id);
	}
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Reagent Lot</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Every fill records the reagent lot (the set of 630 QD, 480 QD, beads and buffers) it was filled with. Pick the lot the chemist prepared; lots are created in the research app under Reagent Lots.
	</p>

	{#if isReadonly}
		<p class="rounded border border-[var(--color-tron-yellow)]/30 bg-[var(--color-tron-yellow)]/5 px-3 py-2 text-xs text-[var(--color-tron-yellow)]">Read-only — viewing past stage</p>
	{/if}

	<div class="space-y-3">
		<label for="reagent-lot-pick" class="text-xs font-medium text-[var(--color-tron-cyan)]">Reagent lot (required)</label>
		<select
			id="reagent-lot-pick"
			bind:value={selectedLotId}
			disabled={isReadonly || submitting}
			class="min-h-[44px] w-full rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none disabled:opacity-50"
		>
			<option value="">Select a reagent lot…</option>
			{#each reagentLots as lot (lot._id)}
				<option value={lot._id}>{lot.lotNumber}{lot.name ? ` · ${lot.name}` : ''}{lot.assayId ? ` · ${lot.assayId}` : ''}</option>
			{/each}
		</select>
		{#if reagentLots.length === 0}
			<p class="text-xs text-red-400">No active reagent lots exist. Create one in the research app (Reagent Lots) before filling.</p>
		{/if}
	</div>

	{#if selectedLot}
		<div class="space-y-4">
			<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 p-4">
				<p class="text-xs text-[var(--color-tron-text-secondary)]">Reagent lot</p>
				<p class="font-mono text-lg font-bold text-[var(--color-tron-cyan)]">{selectedLot.lotNumber}</p>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">{describe(selectedLot)}</p>
			</div>

			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<p class="mb-3 text-xs font-medium text-[var(--color-tron-text-secondary)]">Tube Locations ({tubes.length} tubes)</p>
				<div class="grid grid-cols-3 gap-3">
					{#each tubes as tube (tube.wellPosition)}
						<div class="rounded border border-green-500/30 bg-green-900/10 p-3 text-center">
							<div class="text-xs text-[var(--color-tron-text-secondary)]">Well {tube.wellPosition}</div>
							<div class="mt-1 text-sm font-semibold text-[var(--color-tron-text)]">{tube.reagentName}</div>
							<div class="mt-1 font-mono text-xs text-green-300">{tube.transferTubeId}</div>
						</div>
					{/each}
				</div>
			</div>

			{#if onSaveNote && !isReadonly}
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
					<div class="mb-2 flex items-center justify-between">
						<label for="batch-note" class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Batch Note (optional)</label>
						{#if cartridgeCount > 0}
							<span class="text-[10px] text-[var(--color-tron-text-secondary)]/70">Applies to {cartridgeCount} cartridge{cartridgeCount === 1 ? '' : 's'}</span>
						{/if}
					</div>
					<textarea
						id="batch-note"
						bind:value={noteBody}
						rows="3"
						disabled={noteSaving}
						placeholder="Anything the operator wants attached to every cartridge in this batch..."
						class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)]/50 focus:border-[var(--color-tron-cyan)] focus:outline-none disabled:opacity-50"
					></textarea>
					<div class="mt-2 flex items-center justify-between gap-3">
						<div class="text-xs">
							{#if noteError}
								<span class="text-red-400">{noteError}</span>
							{:else if noteSaving}
								<span class="text-[var(--color-tron-cyan)] animate-pulse">Saving...</span>
							{:else if noteSavedAt}
								<span class="text-green-400">Saved to {noteSavedCount} cartridge{noteSavedCount === 1 ? '' : 's'} at {noteSavedAt.toLocaleTimeString()}</span>
							{:else}
								<span class="text-[var(--color-tron-text-secondary)]/60">Save anytime — re-saving overwrites the previous note.</span>
							{/if}
						</div>
						<button
							type="button"
							onclick={saveNote}
							disabled={!noteBody.trim() || noteSaving || cartridgeCount === 0}
							class="min-h-[36px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-1.5 text-xs font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30 disabled:cursor-not-allowed disabled:opacity-40"
						>
							{noteSaving ? 'Saving...' : 'Save Note'}
						</button>
					</div>
				</div>
			{/if}
		</div>

		<button
			type="button"
			disabled={submitting || isReadonly}
			onclick={handleSubmit}
			class="min-h-[44px] w-full rounded-lg border px-6 py-3 text-sm font-semibold transition-all {!submitting && !isReadonly
				? 'border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30'
				: 'cursor-not-allowed border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] opacity-50'}"
		>
			{#if submitting}
				Confirming...
			{:else}
				Confirm Reagent Lot {selectedLot.lotNumber} ({tubes.length} tubes)
			{/if}
		</button>
	{/if}
</div>
