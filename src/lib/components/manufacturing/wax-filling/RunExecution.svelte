<script lang="ts">
	import { generateTestBarcode } from '$lib/utils/test-barcode';

	interface Props {
		runId: string;
		serverRunStartTime?: Date | null;
		runFinished?: boolean;
		fridges?: { id: string; displayName: string; barcode: string }[];
		onDeckRemoved: (storageLocation: string) => void;
		onRunAgain?: (() => void) | null;
		onAborted: (data: {
			usableCartridgeIds: string[];
			scrapCartridgeIds: string[];
			scrapReason: string;
			columnsCompleted: number;
		}) => void;
		readonly?: boolean;
	}

	let {
		runId,
		serverRunStartTime = null,
		runFinished = false,
		fridges = [],
		onDeckRemoved,
		onRunAgain = null,
		onAborted,
		readonly: isReadonly = false
	}: Props = $props();

	// Run progress/completion is shown by the EmbeddedRunController on the
	// page (OT-2 polling) — this component only owns the deck-removed
	// confirmation and the abort flow.
	type Phase = 'remove_deck' | 'pick_fridge' | 'abort_confirm1' | 'abort_confirm2' | 'abort_recovery';

	let phase = $state<Phase>('remove_deck');
	// Fridge the deck is stored in — picked after "Confirm — Deck Removed".
	let selectedFridge = $state('');

	// Abort recovery state
	let usableScans = $state<string[]>([]);
	let scrapReason = $state('');
	let usableInput = $state('');
	let usableInputEl: HTMLInputElement | undefined = $state();
	let columnsCompleted = $state(0);

	function handleDeckRemoved() {
		// Don't commit yet — first pick the fridge the deck is stored in.
		phase = 'pick_fridge';
	}

	function confirmStore() {
		if (!selectedFridge) return;
		onDeckRemoved(selectedFridge);
	}

	function handleAbortStep1() {
		phase = 'abort_confirm1';
	}

	function handleAbortStep2() {
		phase = 'abort_confirm2';
	}

	function handleAbortConfirmed() {
		phase = 'abort_recovery';
	}

	function handleAbortCancel() {
		phase = 'remove_deck';
	}

	function playBeep(success: boolean) {
		try {
			const ctx = new AudioContext();
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.connect(gain);
			gain.connect(ctx.destination);
			osc.frequency.value = success ? 880 : 220;
			osc.type = 'sine';
			gain.gain.value = 0.3;
			osc.start();
			setTimeout(
				() => {
					osc.stop();
					ctx.close();
				},
				success ? 100 : 300
			);
		} catch {
			/* Audio not supported */
		}
	}

	function handleUsableKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && usableInput.trim()) {
			e.preventDefault();
			const scanned = usableInput.trim();
			if (usableScans.includes(scanned)) {
				playBeep(false);
			} else {
				usableScans = [...usableScans, scanned];
				playBeep(true);
			}
			usableInput = '';
		}
	}

	function removeUsable(id: string) {
		usableScans = usableScans.filter((s) => s !== id);
	}

	function handleRecoveryNoUsable() {
		onAborted({
			usableCartridgeIds: [],
			scrapCartridgeIds: [],
			scrapReason: scrapReason || 'Run aborted',
			columnsCompleted
		});
	}

	function handleRecoveryComplete() {
		onAborted({
			usableCartridgeIds: usableScans,
			scrapCartridgeIds: [],
			scrapReason: scrapReason || 'Run aborted',
			columnsCompleted
		});
	}

	function handleUsableBlur() {
		if (phase === 'abort_recovery') setTimeout(() => usableInputEl?.focus(), 100);
	}

	$effect(() => {
		if (phase === 'abort_recovery' && usableInputEl) usableInputEl.focus();
	});
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Run Execution</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Run ID: <span class="font-mono text-[var(--color-tron-cyan)]">{runId}</span>
	</p>

	<!-- Run info + Deck Removed confirmation -->
	{#if phase === 'remove_deck'}
		<div class="flex flex-col items-center gap-6 py-4">
			<div class="w-full rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-3 text-center">
				<p class="text-xs text-[var(--color-tron-text-secondary)]">Run started</p>
				<p class="font-mono text-lg font-semibold text-[var(--color-tron-cyan)]">
					{serverRunStartTime ? serverRunStartTime.toLocaleTimeString() : '—'}
				</p>
				<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
					{#if runFinished}
						Run finished. Remove the deck and confirm below.
					{:else}
						Robot progress is shown in the run controller above. The deck-removal
						confirmation will appear once the run finishes.
					{/if}
				</p>
			</div>

			{#if runFinished}
				<button
					type="button"
					onclick={handleDeckRemoved}
					disabled={isReadonly}
					class="min-h-[44px] w-full max-w-sm rounded-lg border border-green-500/50 bg-green-900/20 px-8 py-4 text-lg font-bold text-green-400 transition-all hover:bg-green-900/30 disabled:opacity-50"
				>
					Confirm — Deck Removed
				</button>
				{#if onRunAgain}
					<button
						type="button"
						onclick={() => onRunAgain?.()}
						disabled={isReadonly}
						class="min-h-[44px] w-full max-w-sm rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/15 px-8 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-50"
					>
						Run again — same parameters, scan a fresh deck
					</button>
				{/if}
			{:else}
				<div class="flex items-center gap-2 text-sm text-[var(--color-tron-text-secondary)]">
					<svg class="h-4 w-4 animate-spin text-[var(--color-tron-cyan)]" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
					</svg>
					Run in progress…
				</div>
			{/if}
			<button
				type="button"
				onclick={handleAbortStep1}
				disabled={isReadonly}
				class="min-h-[44px] rounded-lg border border-red-500/50 bg-red-900/20 px-6 py-3 text-sm font-semibold text-red-400 transition-all hover:bg-red-900/30 disabled:opacity-50"
			>
				Abort Run
			</button>
		</div>
	{/if}

	<!-- Pick the fridge the deck is stored in, then commit the whole deck at
	     wax_filled (WAX-SIMPLIFY-1: deck-removed → fridge; wax_filled is the stored state). -->
	{#if phase === 'pick_fridge'}
		<div class="flex flex-col items-center gap-5 py-4">
			<div class="w-full max-w-sm text-center">
				<p class="text-lg font-semibold text-[var(--color-tron-text)]">Where is this deck stored?</p>
				<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
					Pick the fridge — every cartridge on this run is recorded there at <span class="font-mono text-[var(--color-tron-cyan)]">wax_filled</span>.
				</p>
			</div>
			<div class="w-full max-w-sm">
				<label for="store-fridge" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Fridge</label>
				<select
					id="store-fridge"
					bind:value={selectedFridge}
					disabled={isReadonly}
					class="min-h-[44px] w-full rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none disabled:opacity-50"
				>
					<option value="">Select a fridge…</option>
					{#each fridges as f (f.id)}
						<option value={f.id}>{f.displayName}{f.barcode ? ` (${f.barcode})` : ''}</option>
					{/each}
				</select>
				{#if fridges.length === 0}
					<p class="mt-1 text-xs text-[var(--color-tron-orange)]">No active fridges found — register one under Equipment.</p>
				{/if}
			</div>
			<button
				type="button"
				onclick={confirmStore}
				disabled={isReadonly || !selectedFridge}
				class="min-h-[44px] w-full max-w-sm rounded-lg border border-green-500/50 bg-green-900/20 px-8 py-4 text-lg font-bold text-green-400 transition-all hover:bg-green-900/30 disabled:cursor-not-allowed disabled:opacity-50"
			>
				Store deck &amp; finish
			</button>
			<button
				type="button"
				onclick={() => (phase = 'remove_deck')}
				disabled={isReadonly}
				class="text-xs text-[var(--color-tron-text-secondary)] underline hover:text-[var(--color-tron-cyan)] disabled:opacity-50"
			>
				← Back
			</button>
		</div>
	{/if}

	<!-- Abort Confirmation 1 -->
	{#if phase === 'abort_confirm1'}
		<div class="rounded-xl border border-red-500/50 bg-red-900/10 p-6 text-center">
			<svg
				class="mx-auto mb-3 h-10 w-10 text-red-400"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				stroke-width="2"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
				/>
			</svg>
			<p class="text-lg font-bold text-red-400">Are you sure?</p>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				Aborting will stop the run and require cartridge recovery.
			</p>
			<div class="mt-5 flex gap-3">
				<button
					type="button"
					onclick={handleAbortCancel}
					class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-3 text-sm font-medium text-[var(--color-tron-text)] transition-all hover:border-[var(--color-tron-cyan)]/30"
				>
					Cancel
				</button>
				<button
					type="button"
					onclick={handleAbortStep2}
					class="min-h-[44px] flex-1 rounded-lg border border-red-500/50 bg-red-900/20 px-4 py-3 text-sm font-bold text-red-400 transition-all hover:bg-red-900/30"
				>
					Yes, Abort
				</button>
			</div>
		</div>
	{/if}

	<!-- Abort Confirmation 2 -->
	{#if phase === 'abort_confirm2'}
		<div class="rounded-xl border-2 border-red-600 bg-red-900/20 p-6 text-center">
			<p class="text-lg font-bold text-red-500">This cannot be undone. Confirm abort?</p>
			<p class="mt-1 text-sm text-red-300">All cartridges in this run will need recovery.</p>
			<div class="mt-5 flex gap-3">
				<button
					type="button"
					onclick={handleAbortCancel}
					class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-3 text-sm font-medium text-[var(--color-tron-text)] transition-all hover:border-[var(--color-tron-cyan)]/30"
				>
					Cancel
				</button>
				<button
					type="button"
					onclick={handleAbortConfirmed}
					class="min-h-[44px] flex-1 rounded-lg border-2 border-red-600 bg-red-900/30 px-4 py-3 text-sm font-black text-red-400 transition-all hover:bg-red-900/40"
				>
					CONFIRM ABORT
				</button>
			</div>
		</div>
	{/if}

	<!-- Abort Recovery -->
	{#if phase === 'abort_recovery'}
		<div class="space-y-5 rounded-xl border border-amber-500/50 bg-amber-900/10 p-6">
			<div>
				<p class="text-lg font-bold text-amber-400">Cartridge Recovery</p>
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
					Are any cartridges usable? Scan usable cartridge barcodes below. Unscanned cartridges
					return to Oven Queue. Remaining will be scrapped.
				</p>
			</div>

			<!-- Columns completed input -->
			<div>
				<label for="columns-completed" class="tron-label">How many columns were filled before abort?</label>
				<input
					id="columns-completed"
					type="number"
					min="0"
					max="3"
					class="tron-input"
					style="max-width: 120px;"
					bind:value={columnsCompleted}
				/>
				<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
					{columnsCompleted} of 3 columns filled. Wax for {3 - columnsCompleted} unfilled column{3 - columnsCompleted !== 1 ? 's' : ''} will be refunded to the incubator tube.
				</p>
			</div>

			<!-- Scrap reason input -->
			<div>
				<label for="scrap-reason" class="tron-label">Abort / Scrap Reason</label>
				<input
					id="scrap-reason"
					type="text"
					class="tron-input"
					placeholder="Enter reason for abort..."
					bind:value={scrapReason}
				/>
			</div>

			<!-- Usable cartridge scan -->
			<div>
				<label for="usable-scan" class="tron-label">Scan Usable Cartridges</label>
				<div class="flex gap-2">
					<input
						bind:this={usableInputEl}
						id="usable-scan"
						type="text"
						class="tron-input flex-1"
						placeholder="Scan usable cartridge barcode..."
						bind:value={usableInput}
						onkeydown={handleUsableKeydown}
						onblur={handleUsableBlur}
						autocomplete="off"
					/>
					<button
						type="button"
						onclick={() => { usableInput = generateTestBarcode('CART'); handleUsableKeydown(new KeyboardEvent('keydown', { key: 'Enter' })); }}
						class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]"
					>
						Test
					</button>
				</div>
			</div>

			{#if usableScans.length > 0}
				<div class="space-y-1.5">
					<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">
						Usable cartridges ({usableScans.length}):
					</p>
					<div class="flex flex-wrap gap-2">
						{#each usableScans as id (id)}
							<span
								class="inline-flex items-center gap-1.5 rounded-md border border-green-500/30 bg-green-900/20 px-2 py-1 font-mono text-xs text-green-400"
							>
								{id}
								<button
									type="button"
									onclick={() => removeUsable(id)}
									class="ml-0.5 text-green-500 hover:text-green-300"
									aria-label="Remove {id}"
								>
									&times;
								</button>
							</span>
						{/each}
					</div>
				</div>
			{/if}

			<div class="flex gap-3">
				<button
					type="button"
					onclick={handleRecoveryNoUsable}
					class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-3 text-sm font-medium text-[var(--color-tron-text)] transition-all hover:border-[var(--color-tron-cyan)]/30"
				>
					No Usable Cartridges
				</button>
				{#if usableScans.length > 0}
					<button
						type="button"
						onclick={handleRecoveryComplete}
						class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
					>
						Confirm Recovery ({usableScans.length} usable)
					</button>
				{/if}
			</div>
		</div>
	{/if}
</div>
