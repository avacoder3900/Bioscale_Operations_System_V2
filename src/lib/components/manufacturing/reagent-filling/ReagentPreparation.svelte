<script lang="ts">
	// Fill-lot picker. A FILL LOT IS ONE REAGENT LOT FILLED ON ONE DAY (2026-11-09): the operator picks the
	// reagent lot and the run joins today's fill lot for it (the server opens it on the first deck). Each
	// run is then a deck of that lot. Default: no fill lot (opt-in) — except that once a deck today has
	// joined a fill lot, its reagent lot is preselected so the next deck is one confirm.

	/** A research-app reagent lot (reagent_set_lots): the bundle of inventory barcodes being filled. */
	interface ReagentLotOption {
		_id: string;
		lotNumber: string;
		name?: string;
		assayId?: string;
		createdAt?: string;
		components?: { role: string; catalogName?: string; manufacturerLotId?: string }[];
	}

	/** One of TODAY's open fill lots (fill_lots): a reagent lot — or none, when reagentLotSource is 'non-calibrated'. */
	interface FillLotOption {
		_id: string;
		fillLotNumber: string;
		name?: string;
		reagentLotId: string;
		reagentLotNumber: string;
		reagentLotSource?: string;
		runIds?: string[];
		fillDate?: string;
	}

	/** Sent as the reagent lot id for a fill lot with no reagent lot. */
	const NON_CALIBRATED = 'non-calibrated';
	const NON_CALIBRATED_LABEL = 'Non-calibrated reagent lot chemicals';

	interface Props {
		reagentLots: ReagentLotOption[];
		/** Today's open fill lots, one per reagent lot. */
		fillLots: FillLotOption[];
		/** The reagent lot of today's last deck on a fill lot ('' = none yet today: default to no fill lot). */
		defaultReagentLotId?: string;
		/** reagentLotId: '' (no fill lot), 'non-calibrated', or a reagent lot id. label: its lot number / 'non-calibrated' / ''. */
		onComplete: (reagentLotId: string, reagentLotLabel: string) => void;
		onSaveNote?: (noteBody: string) => Promise<{ ok: boolean; error?: string; cartridgeCount?: number }>;
		readonly?: boolean;
		cartridgeCount?: number;
	}

	let { reagentLots, fillLots, defaultReagentLotId = '', onComplete, onSaveNote, readonly: isReadonly = false, cartridgeCount = 0 }: Props = $props();

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

	let selectedReagentLotId = $state(defaultReagentLotId);
	let submitting = $state(false);

	const isNonCalibratedLot = (f: FillLotOption) => !f.reagentLotId && f.reagentLotSource === NON_CALIBRATED;
	const selectedLot = $derived(reagentLots.find((l) => l._id === selectedReagentLotId) ?? null);
	/** Today's fill lot this deck will join, or null when this deck opens it. */
	const joining = $derived(
		!selectedReagentLotId ? null : fillLots.find((f) => (selectedReagentLotId === NON_CALIBRATED ? isNonCalibratedLot(f) : f.reagentLotId === selectedReagentLotId)) ?? null
	);
	const decksSoFar = $derived(joining?.runIds?.length ?? 0);
	const isDefault = $derived(!!selectedReagentLotId && selectedReagentLotId === defaultReagentLotId);
	const critical = (lot: ReagentLotOption, role: string) => lot.components?.find((c) => c.role === role);
	const describe = (lot: ReagentLotOption) =>
		['qd630', 'qd480', 'beads']
			.map((r) => { const c = critical(lot, r); return c ? `${r}: ${c.catalogName ?? '?'}${c.manufacturerLotId ? ` (${c.manufacturerLotId})` : ''}` : `${r}: –`; })
			.join(' · ');

	function handleSubmit() {
		if (submitting) return;
		submitting = true;
		onComplete(selectedReagentLotId, selectedReagentLotId === NON_CALIBRATED ? NON_CALIBRATED : (selectedLot?.lotNumber ?? ''));
	}
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Fill Lot</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Optional. A fill lot is one reagent lot filled on one day: pick the reagent lot and this deck joins today's fill lot for it (the first deck of the day opens it). Filling before a calibrated reagent lot exists? Pick "{NON_CALIBRATED_LABEL}" — the reagent lot can be set later in the research app.
	</p>

	{#if isReadonly}
		<p class="rounded border border-[var(--color-tron-yellow)]/30 bg-[var(--color-tron-yellow)]/5 px-3 py-2 text-xs text-[var(--color-tron-yellow)]">Read-only — viewing past stage</p>
	{/if}

	<div class="space-y-3">
		<label for="fill-reagent-lot" class="text-xs font-medium text-[var(--color-tron-cyan)]">Reagent lot (optional — opt in)</label>
		<select
			id="fill-reagent-lot"
			bind:value={selectedReagentLotId}
			disabled={isReadonly || submitting}
			class="min-h-[44px] w-full rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none disabled:opacity-50"
		>
			<option value="">No fill lot (default)</option>
			<option value={NON_CALIBRATED}>{NON_CALIBRATED_LABEL} (no reagent lot yet)</option>
			{#each reagentLots as lot (lot._id)}
				<option value={lot._id}>{lot.lotNumber}{lot.name ? ` · ${lot.name}` : ''}{lot._id === defaultReagentLotId ? " · (today's last deck)" : ''}</option>
			{/each}
		</select>
		{#if reagentLots.length === 0}
			<p class="text-xs text-[var(--color-tron-text-secondary)]">No active reagent lots. Pick "{NON_CALIBRATED_LABEL}", or create one in the research app (Reagent Lots) first.</p>
		{/if}
	</div>

	<div class="space-y-4">
		{#if selectedReagentLotId}
			<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 p-4">
				<p class="text-xs text-[var(--color-tron-text-secondary)]">Fill lot{isDefault ? ' · same as the last deck today' : ''}</p>
				{#if joining}
					<p class="font-mono text-lg font-bold text-[var(--color-tron-cyan)]">{joining.fillLotNumber}{joining.name ? ` · ${joining.name}` : ''} · deck {decksSoFar + 1}</p>
					<p class="text-xs text-[var(--color-tron-text-secondary)]">today's fill lot for this reagent lot · {decksSoFar} deck{decksSoFar === 1 ? '' : 's'} finished so far</p>
				{:else}
					<p class="text-lg font-bold text-[var(--color-tron-cyan)]">New fill lot for today · deck 1</p>
					<p class="text-xs text-[var(--color-tron-text-secondary)]">the first deck of this reagent lot today opens its fill lot; later decks today join it</p>
				{/if}
				{#if selectedReagentLotId === NON_CALIBRATED}
					<p class="text-xs text-[var(--color-tron-yellow)]">non-calibrated reagents — no reagent lot yet</p>
				{:else if selectedLot}
					<p class="text-xs text-[var(--color-tron-text-secondary)]">reagent lot <span class="font-mono">{selectedLot.lotNumber}</span> · {describe(selectedLot)}</p>
				{/if}
			</div>
		{:else}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<p class="text-xs text-[var(--color-tron-text-secondary)]">Fill lot</p>
				<p class="text-lg font-bold text-[var(--color-tron-text)]">None</p>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">Cartridges are filled without a fill lot or reagent lot. Pick a reagent lot above only if this run belongs to a curve set.</p>
			</div>
		{/if}

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
			{:else if selectedReagentLotId}
				Fill on {joining ? `${joining.fillLotNumber} · deck ${decksSoFar + 1}` : "today's new fill lot"}
			{:else}
				Fill with no fill lot
			{/if}
		</button>
</div>
