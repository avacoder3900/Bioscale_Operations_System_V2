<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	interface CartridgeScan {
		cartridgeId: string;
	}

	interface Props {
		onComplete: (data: { deckId: string; cartridgeScans: CartridgeScan[] }) => void;
		readonly?: boolean;
		focusPaused?: boolean;
	}

	let { onComplete, readonly: isReadonly = false, focusPaused = false }: Props = $props();

	// 8 rows x 3 cols, vertical snake: Col1 down, Col2 up, Col3 down
	const GRID_ROWS = [
		[1, 16, 17],
		[2, 15, 18],
		[3, 14, 19],
		[4, 13, 20],
		[5, 12, 21],
		[6, 11, 22],
		[7, 10, 23],
		[8,  9, 24]
	];
	const SCAN_ORDER = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24];
	const TOTAL_POSITIONS = 24;

	let step = $state<'deck' | 'loading'>('deck');
	let deckId = $state('');
	let deckInput = $state('');
	let deckError = $state('');
	let cartridgeInput = $state('');
	let scans = $state<CartridgeScan[]>([]);

	let deckInputEl: HTMLInputElement | undefined = $state();
	let cartridgeInputEl: HTMLInputElement | undefined = $state();
	let deckPendingValue = $state('');

	const nextPosition = $derived(scans.length < TOTAL_POSITIONS ? SCAN_ORDER[scans.length] : null);
	const isFull = $derived(scans.length >= TOTAL_POSITIONS);

	const positionMap = $derived.by(() => {
		const map = new SvelteMap<number, CartridgeScan>();
		for (let i = 0; i < scans.length; i++) {
			map.set(SCAN_ORDER[i], scans[i]);
		}
		return map;
	});

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
			setTimeout(() => { osc.stop(); ctx.close(); }, success ? 100 : 300);
		} catch { /* audio not available */ }
	}

	async function handleDeckKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && deckInput.trim()) {
			e.preventDefault();
			const value = deckInput.trim();
			deckInput = '';
			deckError = '';
			// Validate deck on Enter
			try {
				const res = await fetch(`/api/dev/validate-equipment?type=deck&id=${encodeURIComponent(value)}`);
				const result = await res.json();
				if (!res.ok || result.error) {
					deckError = result.error ?? `Deck "${value}" not found in the system.`;
					playBeep(false);
					return;
				}
			} catch {
				// If validation endpoint unavailable, fall through (backwards compat)
			}
			deckPendingValue = value;
			playBeep(true);
		}
	}

	function confirmDeck() {
		// Validation already done on Enter keydown
		deckId = deckPendingValue;
		deckPendingValue = '';
		step = 'loading';
	}

	function rescanDeck() {
		deckPendingValue = '';
		setTimeout(() => deckInputEl?.focus(), 50);
	}

	async function handleCartridgeKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && cartridgeInput.trim()) {
			e.preventDefault();
			const scanned = cartridgeInput.trim();
			cartridgeInput = '';

			if (isFull) { playBeep(false); return; }

			if (scans.some((s) => s.cartridgeId === scanned)) {
				playBeep(false);
				deckError = `Cartridge "${scanned}" already scanned`;
				return;
			}

			// Validate cartridge: must already exist (came through wax filling)
			try {
				const res = await fetch(`/api/dev/validate-equipment?type=cartridge&id=${encodeURIComponent(scanned)}`);
				const result = await res.json();
				if (!res.ok || result.error) {
					playBeep(false);
					deckError = result.error ?? `Cartridge "${scanned}" validation failed`;
					return;
				}
				if (result.isNew) {
					playBeep(false);
					deckError = `Cartridge not found in system. Must go through wax filling first.`;
					return;
				}
			} catch {
				// If endpoint unavailable, allow scan (backwards compat)
			}

			deckError = '';
			scans = [...scans, { cartridgeId: scanned }];
			playBeep(true);
		}
	}

	function handleDeckBlur() {
		if (step === 'deck' && !focusPaused && !deckPendingValue) setTimeout(() => deckInputEl?.focus(), 100);
	}

	function handleCartridgeBlur() {
		// No auto-refocus — lets buttons register clicks without interference
	}

	function confirmPartialLoad() {
		if (scans.length > 0) {
			onComplete({ deckId, cartridgeScans: [...scans] });
		}
	}

	function undoLastScan() {
		if (scans.length > 0) {
			scans = scans.slice(0, -1);
			deckError = '';
		}
	}

	$effect(() => {
		if (step === 'deck' && deckInputEl && !focusPaused && !deckPendingValue) deckInputEl.focus();
	});

	$effect(() => {
		if (step === 'loading' && cartridgeInputEl && !focusPaused && !isFull) cartridgeInputEl.focus();
	});
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Deck Loading</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Scan deck barcode then load 24 cartridges in snake pattern.
	</p>

	{#if isReadonly}
		<p class="rounded border border-[var(--color-tron-yellow)]/30 bg-[var(--color-tron-yellow)]/5 px-3 py-2 text-xs text-[var(--color-tron-yellow)]">Read-only — viewing past stage</p>
	{/if}

	{#if step === 'deck'}
		<!-- Step 1: Deck barcode scan -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
			{#if !deckPendingValue}
				<div class="flex items-center gap-3">
					<div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]">
						<svg class="h-5 w-5 text-[var(--color-tron-cyan)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
						</svg>
					</div>
					<div class="flex-1">
						<label for="deck-barcode-input" class="tron-label">Scan Deck Barcode</label>
						<input
							bind:this={deckInputEl}
							id="deck-barcode-input"
							type="text"
							class="tron-input"
							placeholder="Scan deck barcode..."
							bind:value={deckInput}
							onkeydown={handleDeckKeydown}
							onblur={handleDeckBlur}
							autocomplete="off"
							autofocus
						/>
					</div>
				</div>
				<button
					type="button"
					onclick={async () => {
					const res = await fetch('/api/dev/test-data?type=deck');
					if (res.ok) {
						const data = await res.json();
						deckInput = data.deckId;
						handleDeckKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
					} else {
						deckError = 'No test decks. Run POST /api/dev/seed-test-inventory first.';
					}
				}}
					class="mt-2 rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]"
				>
					Test
				</button>
			{:else}
				<div class="space-y-3">
					<p class="text-sm text-[var(--color-tron-text-secondary)]">Scanned deck:</p>
					<p class="font-mono text-lg font-semibold text-[var(--color-tron-cyan)]">{deckPendingValue}</p>
					<div class="flex gap-3">
						<button
							type="button"
							onclick={rescanDeck}
							class="min-h-[44px] rounded-lg border border-[var(--color-tron-border)] px-4 py-3 text-sm text-[var(--color-tron-text-secondary)] transition-all hover:border-[var(--color-tron-cyan)]/30"
						>
							Re-scan
						</button>
						<button
							type="button"
							onclick={confirmDeck}
							class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
						>
							Continue
						</button>
					</div>
				</div>
			{/if}
			{#if deckError}
				<p class="mt-2 text-sm text-[var(--color-tron-red)]">{deckError}</p>
			{/if}
		</div>
	{:else}
		<!-- Step 2: Cartridge loading grid -->
		<div class="space-y-4">
			<!-- Deck info bar -->
			<div class="flex items-center justify-between rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-2">
				<span class="text-sm text-[var(--color-tron-text-secondary)]">
					Deck: <span class="font-mono text-[var(--color-tron-cyan)]">{deckId}</span>
				</span>
				<span class="text-sm font-semibold text-[var(--color-tron-text)]">
					{scans.length} / {TOTAL_POSITIONS}
				</span>
			</div>

			<!-- Scan input -->
			{#if !isFull}
				<div class="flex items-center gap-3 rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)] p-4">
					<div class="flex-1">
						<label for="cartridge-scan-input" class="tron-label">
							Scan Cartridge → Position {nextPosition}
						</label>
						<input
							bind:this={cartridgeInputEl}
							id="cartridge-scan-input"
							type="text"
							class="tron-input"
							placeholder="Scan cartridge barcode..."
							bind:value={cartridgeInput}
							onkeydown={handleCartridgeKeydown}
							onblur={handleCartridgeBlur}
							autocomplete="off"
						/>
					</div>
					<button
						type="button"
						onclick={async () => {
						const scannedIds = scans.map((s) => s.cartridgeId).join(',');
						const res = await fetch(`/api/dev/test-data?type=reagent-cartridge&exclude=${scannedIds}`);
						if (res.ok) {
							const data = await res.json();
							cartridgeInput = data.cartridgeId;
							handleCartridgeKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
						} else {
							deckError = 'No test cartridges. Run POST /api/dev/seed-test-inventory first.';
						}
					}}
						class="mt-5 rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]"
					>
						Test
					</button>
				</div>
			{/if}

			{#if deckError}
				<p class="text-sm text-[var(--color-tron-red)]">{deckError}</p>
			{/if}

			<!-- 3x8 Grid -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<div class="mb-2 flex items-center justify-between text-xs text-[var(--color-tron-text-secondary)]">
					<span>Vertical snake: Col 1 ↓  Col 2 ↑  Col 3 ↓</span>
				</div>
				<div class="grid gap-1.5">
					{#each GRID_ROWS as row, rowIndex (rowIndex)}
						<div class="grid grid-cols-3 gap-1.5">
							{#each row as pos (pos)}
								{@const scan = positionMap.get(pos)}
								{@const isNext = pos === nextPosition}
								<div
									class="flex min-h-[44px] flex-col items-center justify-center rounded border text-center text-xs transition-all
										{scan
										? 'border-green-500/50 bg-green-900/30'
										: isNext
											? 'animate-pulse border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/10'
											: 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]'}"
								>
									<span
										class="font-mono text-[10px] {scan
											? 'text-green-400'
											: isNext
												? 'text-[var(--color-tron-cyan)]'
												: 'text-[var(--color-tron-text-secondary)]'}"
									>
										{pos}
									</span>
									{#if scan}
										<span class="mt-0.5 max-w-full truncate px-0.5 font-mono text-[8px] text-green-300">
											{scan.cartridgeId.length > 6 ? scan.cartridgeId.slice(-6) : scan.cartridgeId}
										</span>
									{/if}
								</div>
							{/each}
						</div>
					{/each}
				</div>

				<div class="mt-2 flex justify-between text-[10px] text-[var(--color-tron-text-secondary)]">
					<span>Col 1: 1-8 ↓</span>
					<span>Col 2: 9-16 ↑</span>
					<span>Col 3: 17-24 ↓</span>
				</div>
			</div>

			<!-- Action buttons -->
			<div class="flex gap-3">
				{#if scans.length > 0}
					<button
						type="button"
						onclick={undoLastScan}
						class="min-h-[44px] rounded-lg border border-amber-500/50 bg-amber-900/20 px-4 py-2 text-sm font-medium text-amber-300 transition-all hover:bg-amber-900/30"
					>
						Undo Last
					</button>
				{/if}
				{#if isFull}
					<button
						type="button"
						onclick={confirmPartialLoad}
						class="min-h-[44px] flex-1 rounded-lg border border-green-500/50 bg-green-900/20 px-6 py-3 text-sm font-bold text-green-400 transition-all hover:bg-green-900/30"
					>
						Confirm Full Load ({scans.length} cartridges)
					</button>
				{:else if scans.length > 0}
					<button
						type="button"
						onclick={confirmPartialLoad}
						class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
					>
						Confirm Partial Load ({scans.length} cartridges)
					</button>
				{/if}
			</div>
		</div>
	{/if}
</div>
