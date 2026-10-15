<script lang="ts">
	// Fill-lot picker. The per-well "tube records" this step used to produce were retired
	// 2026-10-13 (vestigial): the fill lot — and through it the reagent lot — is the reagent
	// lineage, and the assay chosen at setup is the cartridge's assay.

	/** A research-app reagent lot (reagent_set_lots): the bundle of inventory barcodes being filled. */
	interface ReagentLotOption {
		_id: string;
		lotNumber: string;
		name?: string;
		assayId?: string;
		createdAt?: string;
		components?: { role: string; catalogName?: string; manufacturerLotId?: string }[];
	}

	/**
	 * A research-app fill lot (fill_lots): one reagent lot, however many robot runs — or, when
	 * reagentLotSource is 'non-calibrated', no reagent lot at all (fills done before the lot exists).
	 */
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

	/** Sent as the reagent lot id to open a fill lot with no reagent lot. */
	const NON_CALIBRATED = 'non-calibrated';
	const NON_CALIBRATED_LABEL = 'Non-calibrated reagent lot chemicals';
	const isNonCalibrated = (f: FillLotOption | null) => !!f && !f.reagentLotId && f.reagentLotSource === NON_CALIBRATED;
	const reagentLabel = (f: FillLotOption) => (isNonCalibrated(f) ? 'non-calibrated reagents' : `reagent lot ${f.reagentLotNumber}`);

	interface Props {
		reagentLots: ReagentLotOption[];
		fillLots: FillLotOption[];
		/** The fill lot used by the most recent run (today's default). */
		defaultFillLotId?: string;
		/** reagentLotLabel = the reagent lot number, or 'non-calibrated' when the fill lot has none. */
		onComplete: (fillLotId: string, reagentLotLabel: string) => void;
		onCreateFillLot?: (reagentLotId: string, name: string) => Promise<{ ok: boolean; error?: string; fillLot?: FillLotOption }>;
		onSaveNote?: (noteBody: string) => Promise<{ ok: boolean; error?: string; cartridgeCount?: number }>;
		readonly?: boolean;
		cartridgeCount?: number;
	}

	let { reagentLots, fillLots, defaultFillLotId = '', onComplete, onCreateFillLot, onSaveNote, readonly: isReadonly = false, cartridgeCount = 0 }: Props = $props();

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

	let lots = $state<FillLotOption[]>(fillLots);
	// Default is NO fill lot (Jacob 2026-10-13): tying a run to a fill lot is opt-in. The last-used
	// lot is only flagged in the list, never preselected.
	let selectedFillLotId = $state('');
	let submitting = $state(false);
	let showNew = $state(false);
	let newReagentLotId = $state('');
	let newName = $state('');
	let creating = $state(false);
	let createError = $state('');

	const selectedFill = $derived(lots.find((f) => f._id === selectedFillLotId) ?? null);
	const selectedLot = $derived(selectedFill ? (reagentLots.find((l) => l._id === selectedFill.reagentLotId) ?? null) : null);
	const isDefault = $derived(!!selectedFill && selectedFill._id === defaultFillLotId);
	const critical = (lot: ReagentLotOption, role: string) => lot.components?.find((c) => c.role === role);
	const describe = (lot: ReagentLotOption) =>
		['qd630', 'qd480', 'beads']
			.map((r) => { const c = critical(lot, r); return c ? `${r}: ${c.catalogName ?? '?'}${c.manufacturerLotId ? ` (${c.manufacturerLotId})` : ''}` : `${r}: –`; })
			.join(' · ');

	async function createFillLot() {
		if (!onCreateFillLot || !newReagentLotId || creating) return;
		creating = true;
		createError = '';
		try {
			const r = await onCreateFillLot(newReagentLotId, newName.trim());
			if (!r.ok || !r.fillLot) {
				createError = r.error ?? 'Could not open the fill lot';
				return;
			}
			lots = [r.fillLot, ...lots];
			selectedFillLotId = r.fillLot._id;
			showNew = false;
			newName = '';
			newReagentLotId = '';
		} catch (e) {
			createError = e instanceof Error ? e.message : 'Could not open the fill lot';
		} finally {
			creating = false;
		}
	}

	function handleSubmit() {
		if (submitting) return;
		submitting = true;
		onComplete(selectedFill?._id ?? '', selectedFill ? selectedFill.reagentLotNumber || NON_CALIBRATED : '');
	}
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Fill Lot</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Optional. By default a run is tied to no fill lot. Opt in when this fill belongs to a curve set: a fill lot is one reagent lot (630 QD, 480 QD, beads and buffers) filled across as many robot runs as you like. Filling before a calibrated reagent lot exists? Open a fill lot on "{NON_CALIBRATED_LABEL}" — the reagent lot can be set on it later in the research app.
	</p>

	{#if isReadonly}
		<p class="rounded border border-[var(--color-tron-yellow)]/30 bg-[var(--color-tron-yellow)]/5 px-3 py-2 text-xs text-[var(--color-tron-yellow)]">Read-only — viewing past stage</p>
	{/if}

	<div class="space-y-3">
		<div class="flex items-center justify-between">
			<label for="fill-lot-pick" class="text-xs font-medium text-[var(--color-tron-cyan)]">Fill lot (optional — opt in)</label>
			{#if onCreateFillLot && !isReadonly}
				<button type="button" onclick={() => (showNew = !showNew)} class="text-xs text-[var(--color-tron-cyan)] underline">{showNew ? 'cancel' : '+ new fill lot'}</button>
			{/if}
		</div>
		<select
			id="fill-lot-pick"
			bind:value={selectedFillLotId}
			disabled={isReadonly || submitting}
			class="min-h-[44px] w-full rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none disabled:opacity-50"
		>
			<option value="">No fill lot (default)</option>
			{#each lots as f (f._id)}
				<option value={f._id}>{f.fillLotNumber}{f.name ? ` · ${f.name}` : ''} · {reagentLabel(f)}{f._id === defaultFillLotId ? ' · (last used)' : ''}</option>
			{/each}
		</select>
		{#if lots.length === 0 && !showNew}
			<p class="text-xs text-[var(--color-tron-text-secondary)]">No open fill lots. If this run needs one, open it here (pick the reagent lot, or "{NON_CALIBRATED_LABEL}") or in the research app under Curves.</p>
		{/if}

		{#if showNew}
			<div class="space-y-2 rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)] p-3">
				<label for="new-fill-reagent-lot" class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Reagent lot for the new fill lot</label>
				<select id="new-fill-reagent-lot" bind:value={newReagentLotId} disabled={creating} class="min-h-[40px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]">
					<option value="">Select a reagent lot…</option>
					<option value={NON_CALIBRATED}>{NON_CALIBRATED_LABEL} (no reagent lot yet)</option>
					{#each reagentLots as lot (lot._id)}
						<option value={lot._id}>{lot.lotNumber}{lot.name ? ` · ${lot.name}` : ''}</option>
					{/each}
				</select>
				{#if newReagentLotId === NON_CALIBRATED}
					<p class="text-xs text-[var(--color-tron-yellow)]">No reagent lot: for fills done before a calibrated lot exists (conjugation / chemistry calibration runs). Cartridges are stamped "non-calibrated"; the reagent lot can be set on this fill lot later in the research app (Curves), which restamps them.</p>
				{:else if reagentLots.length === 0}
					<p class="text-xs text-red-400">No active reagent lots exist. Pick "{NON_CALIBRATED_LABEL}", or create one in the research app (Reagent Lots) first.</p>
				{/if}
				<input type="text" bind:value={newName} disabled={creating} placeholder="name (optional), e.g. Sept 21 algo fill" class="min-h-[40px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
				{#if createError}<p class="text-xs text-red-400">{createError}</p>{/if}
				<button type="button" onclick={createFillLot} disabled={creating || !newReagentLotId} class="min-h-[40px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 text-sm font-semibold text-[var(--color-tron-cyan)] disabled:opacity-40">
					{creating ? 'Opening…' : 'Open fill lot'}
				</button>
			</div>
		{/if}
	</div>

	<div class="space-y-4">
		{#if selectedFill}
			<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 p-4">
				<p class="text-xs text-[var(--color-tron-text-secondary)]">Fill lot{isDefault ? ' · same as the last run' : ''}</p>
				<p class="font-mono text-lg font-bold text-[var(--color-tron-cyan)]">{selectedFill.fillLotNumber}{selectedFill.name ? ` · ${selectedFill.name}` : ''}</p>
				{#if isNonCalibrated(selectedFill)}
					<p class="text-xs text-[var(--color-tron-yellow)]">non-calibrated reagents — no reagent lot yet{selectedFill.runIds?.length ? ` · ${selectedFill.runIds.length} run${selectedFill.runIds.length === 1 ? '' : 's'} so far` : ''}</p>
				{:else}
					<p class="text-xs text-[var(--color-tron-text-secondary)]">reagent lot <span class="font-mono">{selectedFill.reagentLotNumber}</span>{selectedLot ? ` · ${describe(selectedLot)}` : ''}{selectedFill.runIds?.length ? ` · ${selectedFill.runIds.length} run${selectedFill.runIds.length === 1 ? '' : 's'} so far` : ''}</p>
				{/if}
			</div>
		{:else}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<p class="text-xs text-[var(--color-tron-text-secondary)]">Fill lot</p>
				<p class="text-lg font-bold text-[var(--color-tron-text)]">None</p>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">Cartridges are filled without a fill lot or reagent lot. Pick one above only if this run belongs to a curve set.</p>
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
			{:else if selectedFill}
				Fill on {selectedFill.fillLotNumber}
			{:else}
				Fill with no fill lot
			{/if}
		</button>
</div>
