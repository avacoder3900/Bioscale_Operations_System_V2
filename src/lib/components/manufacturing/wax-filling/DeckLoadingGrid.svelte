<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { generateTestBarcode } from '$lib/utils/test-barcode';

	interface OvenLot {
		lotId: string;
		ready: boolean;
		cartridgeCount?: number;
	}

	interface CartridgeScan {
		cartridgeId: string;
		backedLotId: string;
	}

	interface Props {
		availableLots: OvenLot[];
		plannedCartridgeCount?: number | null;
		onComplete: (data: { deckId: string; ovenId: string; cartridgeScans: CartridgeScan[]; countMismatchReason?: string }) => void;
		readonly?: boolean;
		suppressFocus?: boolean;
		// OpentronsRobot._id (or legacy Equipment robot id) — when set, the
		// "Scan Cartridges" button drives the gantry-mounted scanner via
		// /api/scanner/sweep using this robot's default position set.
		robotId?: string | null;
		// Optional run id used as contextRef on the scanner trigger.
		runId?: string | null;
	}

	let { availableLots, plannedCartridgeCount = null, onComplete, readonly: isReadonly = false, suppressFocus = false, robotId = null, runId = null }: Props = $props();

	// 8 rows × 3 cols, vertical snake: Col1 down, Col2 up, Col3 down
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

	let step = $state<'deck' | 'oven' | 'loading'>('deck');
	let deckId = $state('');
	let deckInput = $state('');
	let deckError = $state('');
	let ovenId = $state('');
	let ovenInput = $state('');
	let ovenError = $state('');
	let ovenPendingValue = $state('');
	let ovenInputEl: HTMLInputElement | undefined = $state();
	let cartridgeInput = $state('');
	// Sparse — scans[slotIndex] is either a filled CartridgeScan or null.
	// slotIndex matches SCAN_ORDER position (slotIndex 0 → deck position 1, etc.)
	// so per-slot rescans, per-slot sweep failures, and overrides can all
	// address a specific tile without depending on insertion order.
	let scans = $state<Array<CartridgeScan | null>>(Array(TOTAL_POSITIONS).fill(null));

	let deckInputEl: HTMLInputElement | undefined = $state();
	let cartridgeInputEl: HTMLInputElement | undefined = $state();

	// Per-slot rescan / sweep state
	let failedSlots = $state<Set<number>>(new SvelteSet());
	let sweepFailures = $state<Array<{ slotIndex: number; message: string }>>([]);
	let sweepCount = $state<number>(plannedCartridgeCount ?? TOTAL_POSITIONS);
	let expandedSlot = $state<number | null>(null);
	let expandedInput = $state('');
	let expandedOverride = $state(false);
	let expandedError = $state('');
	let expandedInputEl: HTMLInputElement | undefined = $state();

	// Pending confirm state for deck scan
	let deckPendingValue = $state('');

	// Mismatch modal state
	let showMismatchModal = $state(false);
	let mismatchReason = $state('');

	const readyLots = $derived(availableLots.filter((l) => l.ready));
	const filledCount = $derived(scans.filter((s) => s !== null).length);
	const firstEmptySlotIndex = $derived(scans.findIndex((s) => s === null));
	const nextPosition = $derived(
		firstEmptySlotIndex >= 0 ? SCAN_ORDER[firstEmptySlotIndex] : null
	);
	const isFull = $derived(filledCount >= TOTAL_POSITIONS);

	// Map position -> scan for grid display. slotIndex i ↔ deck position i+1.
	const positionMap = $derived.by(() => {
		const map = new SvelteMap<number, CartridgeScan>();
		for (let i = 0; i < TOTAL_POSITIONS; i++) {
			const s = scans[i];
			if (s) map.set(SCAN_ORDER[i], s);
		}
		return map;
	});

	// Current lot being consumed (FIFO)
	const currentLotIndex = $derived.by(() => {
		if (readyLots.length === 0) return -1;
		// Count scans per lot to determine which lot we're on
		const lotCounts = new SvelteMap<string, number>();
		for (const s of scans) {
			if (!s) continue;
			lotCounts.set(s.backedLotId, (lotCounts.get(s.backedLotId) ?? 0) + 1);
		}
		// Find first lot that hasn't been fully used (max 48 per lot from schema)
		for (let i = 0; i < readyLots.length; i++) {
			const used = lotCounts.get(readyLots[i].lotId) ?? 0;
			if (used < 48) return i;
		}
		return -1;
	});

	const currentLot = $derived(currentLotIndex >= 0 ? readyLots[currentLotIndex] : null);

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

	async function handleDeckKeydown(e: KeyboardEvent) {
		if (isReadonly) return;
		if (e.key === 'Enter' && deckInput.trim()) {
			e.preventDefault();
			const value = deckInput.trim();
			deckInput = '';
			deckError = '';
			// Validate on Enter before showing confirm UI
			try {
				const res = await fetch(`/api/dev/validate-equipment?type=deck&id=${encodeURIComponent(value)}`);
				const result = await res.json();
				if (!res.ok || result.error) {
					deckError = result.error ?? `Deck "${value}" not found in the system.`;
					playBeep(false);
					return;
				}
			} catch {
				deckError = 'Validation service unavailable, cannot proceed';
				playBeep(false);
				return;
			}
			deckPendingValue = value;
			playBeep(true);
		}
	}

	let deckValidating = $state(false);

	function confirmDeck() {
		// Validation already done on Enter keydown
		deckId = deckPendingValue;
		deckPendingValue = '';
		// Skip oven scan — deck is being REMOVED from oven, not placed into one.
		// Oven scan happens at step 4 (deck removal) after the OT-2 run completes.
		step = 'loading';
	}

	function rescanDeck() {
		deckPendingValue = '';
		setTimeout(() => deckInputEl?.focus(), 50);
	}

	async function handleOvenKeydown(e: KeyboardEvent) {
		if (isReadonly) return;
		if (e.key === 'Enter' && ovenInput.trim()) {
			e.preventDefault();
			const value = ovenInput.trim();
			ovenInput = '';
			ovenError = '';
			try {
				const res = await fetch(`/api/dev/validate-equipment?type=oven&id=${encodeURIComponent(value)}`);
				const result = await res.json();
				if (!res.ok || result.error) {
					ovenError = result.error ?? `Oven "${value}" not found.`;
					playBeep(false);
					return;
				}
				ovenPendingValue = result.id ?? value;
				playBeep(true);
			} catch {
				ovenError = 'Validation service unavailable, cannot proceed';
				playBeep(false);
			}
		}
	}

	function confirmOven() {
		ovenId = ovenPendingValue;
		ovenPendingValue = '';
		step = 'loading';
	}

	function rescanOven() {
		ovenPendingValue = '';
		setTimeout(() => ovenInputEl?.focus(), 50);
	}

	async function processScannedCartridge(
		scanned: string,
		opts: { slotIndex?: number; override?: boolean } = {}
	): Promise<{ ok: boolean; error?: string }> {
		const targetSlot = opts.slotIndex ?? firstEmptySlotIndex;
		if (targetSlot < 0 || targetSlot >= TOTAL_POSITIONS) {
			return { ok: false, error: `Deck is full (${TOTAL_POSITIONS} max)` };
		}
		// Refuse to overwrite a filled slot unless override is explicitly set.
		if (!opts.override && scans[targetSlot] !== null) {
			return {
				ok: false,
				error: `Slot ${targetSlot + 1} is already filled — enable override to replace.`
			};
		}
		// Duplicate-in-session check skips the slot we're about to write to (so
		// an override that re-scans the same cartridge into the same slot is a
		// no-op rather than an error).
		if (!opts.override) {
			const dupIndex = scans.findIndex((s, i) => s?.cartridgeId === scanned && i !== targetSlot);
			if (dupIndex >= 0) {
				return {
					ok: false,
					error: `Cartridge "${scanned}" already scanned in this session (slot ${dupIndex + 1})`
				};
			}
		}
		if (!currentLot) {
			return { ok: false, error: 'No available oven-ready lots' };
		}
		try {
			const res = await fetch(`/api/dev/validate-equipment?type=cartridge&id=${encodeURIComponent(scanned)}`);
			const result = await res.json();
			if (!res.ok || result.error) {
				return { ok: false, error: result.error ?? `Cartridge "${scanned}" validation failed` };
			}
		} catch {
			return { ok: false, error: 'Validation service unavailable, cannot proceed' };
		}
		const next = scans.slice();
		next[targetSlot] = { cartridgeId: scanned, backedLotId: currentLot.lotId };
		scans = next;
		// Clear failed-slot flag now that this slot has a valid scan.
		if (failedSlots.has(targetSlot)) {
			const fs = new SvelteSet(failedSlots);
			fs.delete(targetSlot);
			failedSlots = fs;
		}
		return { ok: true };
	}

	async function handleCartridgeKeydown(e: KeyboardEvent) {
		if (isReadonly) return;
		if (e.key === 'Enter' && cartridgeInput.trim()) {
			e.preventDefault();
			const scanned = cartridgeInput.trim();
			cartridgeInput = '';
			const r = await processScannedCartridge(scanned);
			if (r.ok) {
				deckError = '';
				playBeep(true);
			} else {
				deckError = r.error ?? 'Scan failed';
				playBeep(false);
			}
		}
	}

	let sweepInFlight = $state(false);
	let sweepProgress = $state<string | null>(null);

	async function autoSweepCartridges() {
		if (isReadonly) return;
		if (!robotId) {
			deckError = 'No robot configured for this run — cannot auto-scan.';
			return;
		}
		if (!currentLot) {
			deckError = 'No available oven-ready lots';
			return;
		}
		const cap = Math.max(1, Math.min(TOTAL_POSITIONS, Math.floor(sweepCount)));
		deckError = '';
		sweepProgress = `Driving robot to scan ${cap} position${cap === 1 ? '' : 's'}…`;
		sweepInFlight = true;
		// Reset prior per-slot failure state — a new sweep starts fresh.
		failedSlots = new SvelteSet();
		sweepFailures = [];

		try {
			const res = await fetch('/api/scanner/sweep', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					robotId,
					source: 'wax_filling',
					contextRef: runId ?? undefined,
					maxSlots: cap
				})
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				deckError = (body?.message ?? body?.error ?? `Sweep failed (HTTP ${res.status})`).toString();
				playBeep(false);
				return;
			}
			const incomingScans: Array<{ slotIndex: number; barcode: string }> = body?.scans ?? [];
			const sweepErrors: Array<{ slotIndex: number; message: string }> = body?.errors ?? [];

			// Place barcodes at their actual slotIndex. Collect every failure
			// (server-side scanner errors + client-side validation failures) so
			// the user sees the full picture instead of one fatal error.
			const failures: Array<{ slotIndex: number; message: string }> = [];
			const failedSet = new SvelteSet<number>();

			for (const err of sweepErrors) {
				failures.push(err);
				failedSet.add(err.slotIndex);
			}

			let added = 0;
			for (const s of incomingScans) {
				sweepProgress = `Recording slot ${s.slotIndex + 1}…`;
				const r = await processScannedCartridge(s.barcode, { slotIndex: s.slotIndex });
				if (r.ok) {
					added++;
				} else {
					failures.push({
						slotIndex: s.slotIndex,
						message: r.error ?? 'validation failed'
					});
					failedSet.add(s.slotIndex);
				}
			}

			failedSlots = failedSet;
			sweepFailures = failures.sort((a, b) => a.slotIndex - b.slotIndex);

			if (failures.length > 0) {
				deckError = `Captured ${added}/${cap}. ${failures.length} slot${failures.length === 1 ? '' : 's'} need manual rescan — click the red tiles below.`;
				playBeep(false);
			} else {
				sweepProgress = `Captured ${added}/${cap} cartridges.`;
				playBeep(true);
			}
		} catch (e) {
			deckError = e instanceof Error ? e.message : String(e);
			playBeep(false);
		} finally {
			sweepInFlight = false;
			setTimeout(() => { sweepProgress = null; }, 4000);
		}
	}

	function openSlot(slotIndex: number) {
		if (isReadonly) return;
		expandedSlot = slotIndex;
		expandedInput = '';
		expandedOverride = scans[slotIndex] !== null; // pre-arm override on filled slots
		expandedError = '';
		setTimeout(() => expandedInputEl?.focus(), 30);
	}

	function closeSlot() {
		expandedSlot = null;
		expandedInput = '';
		expandedOverride = false;
		expandedError = '';
	}

	async function handleExpandedKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			closeSlot();
			return;
		}
		if (e.key !== 'Enter' || !expandedInput.trim() || expandedSlot === null) return;
		e.preventDefault();
		const scanned = expandedInput.trim();
		const target = expandedSlot;
		const r = await processScannedCartridge(scanned, {
			slotIndex: target,
			override: expandedOverride
		});
		if (r.ok) {
			expandedError = '';
			playBeep(true);
			closeSlot();
		} else {
			expandedError = r.error ?? 'Scan failed';
			expandedInput = '';
			playBeep(false);
			setTimeout(() => expandedInputEl?.focus(), 30);
		}
	}

	function handleDeckBlur() {
		if (step === 'deck' && !suppressFocus && !deckPendingValue) setTimeout(() => deckInputEl?.focus(), 100);
	}

	function handleCartridgeBlur() {
		// No auto-refocus — lets buttons register clicks without interference
	}

	// Dense, slot-ordered snapshot for completion handlers. Server doesn't track
	// per-slot index; it just records each scanned cartridge. So we filter out
	// the null slots and send the remaining scans in slot order.
	function denseScans(): CartridgeScan[] {
		return scans.filter((s): s is CartridgeScan => s !== null);
	}

	function tryComplete() {
		if (filledCount === 0) return;
		// Check for mismatch with planned count
		if (plannedCartridgeCount != null && filledCount !== plannedCartridgeCount) {
			showMismatchModal = true;
			return;
		}
		onComplete({ deckId, ovenId, cartridgeScans: denseScans() });
	}

	function confirmMismatch() {
		if (!mismatchReason.trim()) return;
		showMismatchModal = false;
		onComplete({
			deckId,
			ovenId,
			cartridgeScans: denseScans(),
			countMismatchReason: mismatchReason.trim()
		});
		mismatchReason = '';
	}

	function confirmPartialLoad() {
		if (filledCount === 0) return;
		onComplete({ deckId, ovenId, cartridgeScans: denseScans() });
	}

	function undoLastScan() {
		// Clear the highest-index filled slot. With sparse state the "last
		// scan" is no longer trivially scans[-1] — find the highest filled
		// slotIndex and null it out.
		let lastIdx = -1;
		for (let i = scans.length - 1; i >= 0; i--) {
			if (scans[i] !== null) {
				lastIdx = i;
				break;
			}
		}
		if (lastIdx < 0) return;
		const next = scans.slice();
		next[lastIdx] = null;
		scans = next;
		deckError = '';
	}

	$effect(() => {
		if (step === 'deck' && deckInputEl && !isReadonly && !suppressFocus && !deckPendingValue) deckInputEl.focus();
	});

	$effect(() => {
		if (step === 'oven' && ovenInputEl && !isReadonly && !suppressFocus && !ovenPendingValue) ovenInputEl.focus();
	});

	$effect(() => {
		if (step === 'loading' && cartridgeInputEl && !isReadonly && !suppressFocus && !showMismatchModal && !isFull) cartridgeInputEl.focus();
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
		<div
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5"
		>
			{#if !deckPendingValue}
				<div class="flex items-center gap-3">
					<div
						class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]"
					>
						<svg
							class="h-5 w-5 text-[var(--color-tron-cyan)]"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width="2"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
							/>
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
							autofocus
							autocomplete="off"
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
	{:else if step === 'oven'}
		<!-- Step 1b: Oven barcode scan — which oven this deck will go into -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
			<p class="mb-3 text-xs text-[var(--color-tron-text-secondary)]">
				Deck <span class="font-mono text-[var(--color-tron-cyan)]">{deckId}</span> confirmed. Scan the oven this deck will go into.
			</p>
			{#if !ovenPendingValue}
				<div>
					<label for="oven-barcode-input" class="tron-label">Scan Oven Barcode</label>
					<input
						bind:this={ovenInputEl}
						id="oven-barcode-input"
						type="text"
						class="tron-input"
						placeholder="Scan oven barcode..."
						bind:value={ovenInput}
						onkeydown={handleOvenKeydown}
						autocomplete="off"
					/>
				</div>
			{:else}
				<div class="space-y-3">
					<p class="text-sm text-[var(--color-tron-text-secondary)]">Scanned oven:</p>
					<p class="font-mono text-lg font-semibold text-[var(--color-tron-cyan)]">{ovenPendingValue}</p>
					<div class="flex gap-3">
						<button
							type="button"
							onclick={rescanOven}
							class="min-h-[44px] rounded-lg border border-[var(--color-tron-border)] px-4 py-3 text-sm text-[var(--color-tron-text-secondary)] transition-all hover:border-[var(--color-tron-cyan)]/30"
						>
							Re-scan
						</button>
						<button
							type="button"
							onclick={confirmOven}
							class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
						>
							Continue
						</button>
					</div>
				</div>
			{/if}
			{#if ovenError}
				<p class="mt-2 text-sm text-[var(--color-tron-red)]">{ovenError}</p>
			{/if}
		</div>
	{:else}
		<!-- Step 2: Cartridge loading grid -->
		<div class="space-y-4">
			<!-- Deck info bar -->
			<div
				class="flex items-center justify-between rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-2"
			>
				<span class="text-sm text-[var(--color-tron-text-secondary)]">
					Deck: <span class="font-mono text-[var(--color-tron-cyan)]">{deckId}</span>
				</span>
				<div class="flex items-center gap-3">
					{#if plannedCartridgeCount != null}
						<span class="text-xs text-[var(--color-tron-text-secondary)]">
							Planned: <span class="font-semibold text-[var(--color-tron-text)]">{plannedCartridgeCount}</span>
						</span>
					{/if}
					<span class="text-sm font-semibold {plannedCartridgeCount != null && filledCount > 0 && filledCount !== plannedCartridgeCount ? 'text-amber-400' : 'text-[var(--color-tron-text)]'}">
						{filledCount} / {TOTAL_POSITIONS}
					</span>
				</div>
			</div>

			<!-- Current lot indicator -->
			{#if currentLot}
				<div class="flex items-center gap-2 text-xs text-[var(--color-tron-text-secondary)]">
					<span class="inline-block h-2 w-2 rounded-full bg-green-500" aria-hidden="true"></span>
					Loading from lot:
					<span class="font-mono text-[var(--color-tron-cyan)]">{currentLot.lotId}</span>
				</div>
			{/if}

			<!-- Auto-sweep button (gantry-mounted scanner) -->
			{#if !isFull && !isReadonly && robotId}
				<div class="rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/5 p-4">
					<div class="flex items-center justify-between gap-3">
						<div>
							<div class="text-sm font-semibold" style="color: var(--color-tron-cyan)">Scan Cartridges</div>
							<div class="text-[11px]" style="color: var(--color-tron-text-secondary)">
								Drive the OT-2 to each taught position and read every barcode automatically.
							</div>
						</div>
						<div class="flex items-center gap-2">
							<label class="flex flex-col text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
								Count
								<input
									type="number"
									min="1"
									max={TOTAL_POSITIONS}
									bind:value={sweepCount}
									disabled={sweepInFlight}
									class="w-16 rounded border border-[var(--color-tron-cyan)]/40 bg-black/30 px-2 py-1 text-center font-mono text-sm text-[var(--color-tron-cyan)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
								/>
							</label>
							<button
								type="button"
								onclick={autoSweepCartridges}
								disabled={sweepInFlight}
								class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-4 py-2 text-sm font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-40"
							>
								{sweepInFlight ? 'Scanning…' : 'Scan Cartridges'}
							</button>
						</div>
					</div>
					<p class="mt-2 rounded border border-amber-500/30 bg-amber-900/15 px-2 py-1 text-[11px] text-amber-200/90">
						Auto-scan only works when BIMS is running on a Mac on the lab LAN (e.g.
						<span class="font-mono">localhost:5176</span>). The cloud deploy can't reach the OT-2's
						private-network address. Handheld scan input below works from any deployment.
					</p>
					{#if sweepProgress}
						<p class="mt-2 text-[11px]" style="color: var(--color-tron-text-secondary)">{sweepProgress}</p>
					{/if}
					{#if sweepFailures.length > 0}
						<div class="mt-2 rounded border border-red-500/40 bg-red-900/15 p-2">
							<p class="text-[11px] font-semibold text-red-300">
								{sweepFailures.length} slot{sweepFailures.length === 1 ? '' : 's'} need manual rescan — click the red tiles below
							</p>
							<ul class="mt-1 space-y-0.5 text-[10px] text-red-200/90">
								{#each sweepFailures as f (f.slotIndex)}
									<li>Slot {f.slotIndex + 1}: {f.message}</li>
								{/each}
							</ul>
						</div>
					{/if}
				</div>
			{/if}

			<!-- Per-slot rescan panel — shows when a tile is clicked -->
			{#if expandedSlot !== null && !isReadonly}
				<div class="rounded-lg border border-[var(--color-tron-cyan)]/60 bg-[var(--color-tron-cyan)]/10 p-4">
					<div class="flex items-start justify-between gap-3">
						<div class="flex-1">
							<div class="text-sm font-semibold" style="color: var(--color-tron-cyan)">
								Slot {expandedSlot + 1}
								{#if scans[expandedSlot]}
									<span class="ml-2 font-mono text-[11px] text-green-300">currently: {scans[expandedSlot]?.cartridgeId}</span>
								{:else if failedSlots.has(expandedSlot)}
									<span class="ml-2 text-[11px] text-red-300">(failed during auto-scan)</span>
								{:else}
									<span class="ml-2 text-[11px]" style="color: var(--color-tron-text-secondary)">(empty)</span>
								{/if}
							</div>
							<label for="slot-rescan-input" class="tron-label mt-2 block">
								Scan or paste cartridge barcode
							</label>
							<input
								bind:this={expandedInputEl}
								id="slot-rescan-input"
								type="text"
								class="tron-input"
								placeholder="Scan cartridge barcode..."
								bind:value={expandedInput}
								onkeydown={handleExpandedKeydown}
								autocomplete="off"
							/>
							<label class="mt-2 flex items-center gap-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
								<input type="checkbox" bind:checked={expandedOverride} class="accent-[var(--color-tron-cyan)]" />
								Override (allow replacing the cartridge already in this slot and bypass session-duplicate check)
							</label>
							{#if expandedError}
								<p class="mt-2 text-[11px] text-red-300">{expandedError}</p>
							{/if}
						</div>
						<button
							type="button"
							onclick={closeSlot}
							class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
						>
							Close
						</button>
					</div>
				</div>
			{/if}

			<!-- Manual scan input (fallback / handheld) -->
			{#if !isFull}
				<div
					class="flex items-center gap-3 rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)] p-4"
				>
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
						onclick={() => { if (isFull) return; cartridgeInput = generateTestBarcode('CART'); handleCartridgeKeydown(new KeyboardEvent('keydown', { key: 'Enter' })); }}
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
			<div
				class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
			>
				<div
					class="mb-2 flex items-center justify-between text-xs text-[var(--color-tron-text-secondary)]"
				>
					<span>Vertical snake: Col 1 ↓  Col 2 ↑  Col 3 ↓</span>
				</div>
				<div class="grid gap-1.5">
					{#each GRID_ROWS as row, rowIndex (rowIndex)}
						<div class="grid grid-cols-3 gap-1.5">
							{#each row as pos (pos)}
								{@const slotIdx = pos - 1}
								{@const scan = positionMap.get(pos)}
								{@const isNext = pos === nextPosition}
								{@const isFailed = failedSlots.has(slotIdx)}
								{@const isExpanded = expandedSlot === slotIdx}
								<button
									type="button"
									onclick={() => openSlot(slotIdx)}
									disabled={isReadonly}
									title={scan
										? `Slot ${pos}: ${scan.cartridgeId} — click to override`
										: isFailed
											? `Slot ${pos}: failed during auto-scan — click to rescan`
											: `Slot ${pos}: click to scan`}
									class="flex min-h-[44px] flex-col items-center justify-center rounded border text-center text-xs transition-all
										{isExpanded
											? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/25 ring-1 ring-[var(--color-tron-cyan)]'
											: isFailed
												? 'border-red-500/70 bg-red-900/30'
												: scan
													? 'border-green-500/50 bg-green-900/30'
													: isNext
														? 'animate-pulse border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/10'
														: 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]'}
										{isReadonly ? 'cursor-default' : 'cursor-pointer hover:border-[var(--color-tron-cyan)]'}"
								>
									<span
										class="font-mono text-[10px] {isFailed
											? 'text-red-300'
											: scan
												? 'text-green-400'
												: isNext
													? 'text-[var(--color-tron-cyan)]'
													: 'text-[var(--color-tron-text-secondary)]'}"
									>
										{pos}
									</span>
									{#if scan}
										<span
											class="mt-0.5 w-full break-all px-0.5 font-mono text-[8px] leading-tight text-green-300"
											title={scan.cartridgeId}
										>
											{scan.cartridgeId}
										</span>
									{:else if isFailed}
										<span class="mt-0.5 text-[8px] font-semibold text-red-300">rescan</span>
									{/if}
								</button>
							{/each}
						</div>
					{/each}
				</div>

				<!-- Row labels -->
				<div class="mt-2 flex justify-between text-[10px] text-[var(--color-tron-text-secondary)]">
					<span>Col 1: 1-8 ↓</span>
					<span>Col 2: 9-16 ↑</span>
					<span>Col 3: 17-24 ↓</span>
				</div>
			</div>

			<!-- Action buttons -->
			<div class="flex gap-3">
				{#if filledCount > 0}
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
						onclick={tryComplete}
						class="min-h-[44px] flex-1 rounded-lg border border-green-500/50 bg-green-900/20 px-6 py-3 text-sm font-bold text-green-400 transition-all hover:bg-green-900/30"
					>
						Confirm Full Load ({filledCount} cartridges)
					</button>
				{:else if filledCount > 0}
					<button
						type="button"
						onclick={confirmPartialLoad}
						class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
					>
						Confirm Partial Load ({filledCount} cartridges)
					</button>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Count mismatch modal -->
	{#if showMismatchModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div class="mx-4 w-full max-w-md rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 shadow-xl">
				<h3 class="text-lg font-semibold text-amber-400">Cartridge Count Mismatch</h3>
				<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
					You planned <span class="font-bold text-[var(--color-tron-text)]">{plannedCartridgeCount}</span> cartridges
					but scanned <span class="font-bold text-[var(--color-tron-text)]">{filledCount}</span>.
					The wax calculation will use the actual scanned count ({filledCount}).
				</p>
				<label class="mt-4 block">
					<span class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Reason for mismatch</span>
					<textarea
						bind:value={mismatchReason}
						rows="3"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
						placeholder="Explain why the count differs from planned..."
					></textarea>
				</label>
				<div class="mt-4 flex justify-end gap-3">
					<button
						type="button"
						onclick={() => { showMismatchModal = false; mismatchReason = ''; }}
						class="rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-border)]/30"
					>
						Go Back
					</button>
					<button
						type="button"
						onclick={confirmMismatch}
						disabled={!mismatchReason.trim()}
						class="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
					>
						Confirm with {filledCount} Cartridges
					</button>
				</div>
			</div>
		</div>
	{/if}
</div>
