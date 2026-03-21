<script lang="ts">
	import FinishTimerButton from '$lib/components/ui/FinishTimerButton.svelte';
	import EquipmentDiagram from '$lib/components/manufacturing/EquipmentDiagram.svelte';
	import { generateTestBarcode } from '$lib/utils/test-barcode';

	interface Props {
		runEndTime: Date;
		coolingWarningMin: number;
		deckLockoutMin: number;
		onComplete: (data: { trayId: string; coolingTimestamp: Date }) => void;
		readonly?: boolean;
		suppressFocus?: boolean;
	}

	let { runEndTime, coolingWarningMin = 15, deckLockoutMin = 25, onComplete, readonly: isReadonly = false, suppressFocus = false }: Props = $props();

	type Step = 'scan_tray' | 'confirm_cooling' | 'place_deck';

	let step = $state<Step>('scan_tray');
	let trayId = $state('');
	let trayInput = $state('');
	let trayPendingValue = $state('');
	let coolingTimestamp = $state<Date | null>(null);
	let tick = $state(0);
	let inputEl: HTMLInputElement | undefined = $state();

	const elapsedMs = $derived.by(() => {
		void tick;
		return Date.now() - runEndTime.getTime();
	});

	const elapsedMin = $derived(Math.floor(elapsedMs / 60_000));
	const elapsedSec = $derived(Math.floor((elapsedMs % 60_000) / 1000));
	const elapsedDisplay = $derived(
		`${String(elapsedMin).padStart(2, '0')}:${String(elapsedSec).padStart(2, '0')}`
	);

	const isTransferOverdue = $derived(elapsedMin >= coolingWarningMin);

	// Timer tick for elapsed time
	$effect(() => {
		if (step === 'scan_tray' || step === 'confirm_cooling') {
			const interval = setInterval(() => {
				tick++;
			}, 1000);
			return () => clearInterval(interval);
		}
	});

	// Auto-focus tray input (suppressed when modal is open)
	$effect(() => {
		if (step === 'scan_tray' && inputEl && !suppressFocus && !trayPendingValue) {
			const modal = document.querySelector('.fixed.inset-0.z-50');
			if (!modal) inputEl.focus();
		}
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

	function handleTrayScan(e: KeyboardEvent) {
		if (e.key === 'Enter' && trayInput.trim()) {
			e.preventDefault();
			trayPendingValue = trayInput.trim();
			trayInput = '';
			playBeep(true);
		}
	}

	let trayValidating = $state(false);
	let trayError = $state('');

	async function confirmTray() {
		trayValidating = true;
		trayError = '';
		try {
			const res = await fetch(`/api/dev/validate-equipment?type=tray&id=${encodeURIComponent(trayPendingValue)}`);
			const result = await res.json();
			if (!res.ok || result.error) {
				trayError = result.error ?? `Tray "${trayPendingValue}" not found in the system.`;
				playBeep(false);
				trayValidating = false;
				return;
			}
		} catch {
			// If endpoint unavailable, fall through
		}
		trayValidating = false;
		trayId = trayPendingValue;
		trayPendingValue = '';
		step = 'confirm_cooling';
	}

	function rescanTray() {
		trayPendingValue = '';
		setTimeout(() => inputEl?.focus(), 50);
	}

	function handleTrayBlur() {
		if (step === 'scan_tray' && !suppressFocus && !trayPendingValue) {
			setTimeout(() => {
				// Don't steal focus if a modal/overlay is open (z-50 fixed overlay)
				const modal = document.querySelector('.fixed.inset-0.z-50');
				if (modal) return;
				inputEl?.focus();
			}, 100);
		}
	}

	function handleConfirmCooling() {
		coolingTimestamp = new Date();
		step = 'place_deck';
	}

	function handleFinishTimer() {
		// Skip directly to confirm cooling step
		if (step === 'scan_tray') return; // Still need tray scan
		if (step === 'confirm_cooling') {
			handleConfirmCooling();
		}
	}

	function handleDeckPlaced() {
		if (!coolingTimestamp) return;
		onComplete({ trayId, coolingTimestamp });
	}
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Post-Run Cooling</h2>

	<!-- Elapsed time since run ended -->
	<div
		class="rounded-lg border px-4 py-3 {isTransferOverdue
			? 'border-amber-500/50 bg-amber-900/20'
			: 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]'}"
	>
		<p
			class="text-xs font-medium {isTransferOverdue
				? 'text-amber-400'
				: 'text-[var(--color-tron-text-secondary)]'}"
		>
			Time since run ended
		</p>
		<p
			class="font-mono text-2xl font-bold {isTransferOverdue
				? 'text-amber-400'
				: 'text-[var(--color-tron-cyan)]'}"
		>
			{elapsedDisplay}
		</p>
		{#if isTransferOverdue}
			<p class="mt-1 text-sm font-medium text-amber-400">
				Transfer time exceeds {coolingWarningMin} minutes
			</p>
		{/if}
		<div class="mt-2">
			<FinishTimerButton onFinish={handleFinishTimer} label="Skip Timer" />
		</div>
	</div>

	<!-- Step indicators -->
	<div class="flex items-center gap-2 text-xs">
		{#each [{ n: 1, label: 'Scan Tray' }, { n: 2, label: 'Confirm Cooling' }, { n: 3, label: 'Place Deck' }] as s (s.n)}
			{@const active =
				(s.n === 1 && step === 'scan_tray') ||
				(s.n === 2 && step === 'confirm_cooling') ||
				(s.n === 3 && step === 'place_deck')}
			{@const done = (s.n === 1 && step !== 'scan_tray') || (s.n === 2 && step === 'place_deck')}
			<div class="flex items-center gap-1.5">
				<div
					class="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold {done
						? 'bg-green-500 text-white'
						: active
							? 'bg-[var(--color-tron-cyan)] text-white'
							: 'border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)]'}"
				>
					{#if done}
						<svg
							class="h-3.5 w-3.5"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width="3"
						>
							<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
						</svg>
					{:else}
						{s.n}
					{/if}
				</div>
				<span
					class={active
						? 'text-[var(--color-tron-cyan)]'
						: done
							? 'text-green-400'
							: 'text-[var(--color-tron-text-secondary)]'}>{s.label}</span
				>
			</div>
			{#if s.n < 3}
				<div class="h-px flex-1 {done ? 'bg-green-500/50' : 'bg-[var(--color-tron-border)]'}"></div>
			{/if}
		{/each}
	</div>

	<!-- Step 1: Scan cooling tray barcode -->
	{#if step === 'scan_tray'}
		{#if !trayPendingValue}
			<div class="space-y-3">
				<label for="tray-scan" class="tron-label">Scan Cooling Tray Barcode</label>
				<div class="flex gap-2">
					<input
						bind:this={inputEl}
						id="tray-scan"
						type="text"
						class="tron-input flex-1"
						placeholder="Scan or type tray barcode..."
						bind:value={trayInput}
						onkeydown={handleTrayScan}
						onblur={handleTrayBlur}
						autocomplete="off"
					/>
					<button
						type="button"
						onclick={() => { trayInput = generateTestBarcode('TRAY'); handleTrayScan(new KeyboardEvent('keydown', { key: 'Enter' })); }}
						class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]"
					>
						Test
					</button>
				</div>
			</div>
		{:else}
			<div class="space-y-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
				<p class="text-sm text-[var(--color-tron-text-secondary)]">Scanned cooling tray:</p>
				<p class="font-mono text-lg font-semibold text-[var(--color-tron-cyan)]">{trayPendingValue}</p>
				{#if trayError}
					<p class="text-sm text-red-400">{trayError}</p>
				{/if}
				<div class="flex gap-3">
					<button
						type="button"
						onclick={rescanTray}
						class="min-h-[44px] rounded-lg border border-[var(--color-tron-border)] px-4 py-3 text-sm text-[var(--color-tron-text-secondary)] transition-all hover:border-[var(--color-tron-cyan)]/30"
					>
						Re-scan
					</button>
					<button
						type="button"
						onclick={confirmTray}
						disabled={trayValidating}
						class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30 disabled:opacity-50"
					>
						{trayValidating ? 'Checking...' : 'Continue'}
					</button>
				</div>
			</div>
		{/if}
	{/if}

	<!-- Step 2: Confirm cooling -->
	{#if step === 'confirm_cooling'}
		<div class="space-y-4">
			<div
				class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-3"
			>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">Cooling Tray</p>
				<p class="font-mono text-lg font-semibold text-[var(--color-tron-cyan)]">{trayId}</p>
			</div>
			<!-- Tray → Fridge placement diagram -->
			<EquipmentDiagram type="tray" destination="fridge" trayId={trayId} />
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Transfer cartridges to the cooling tray, then place in fridge and confirm below.
			</p>
			<button
				type="button"
				onclick={handleConfirmCooling}
				class="min-h-[44px] w-full rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-4 text-lg font-bold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
			>
				Cartridges Are Being Cooled
			</button>
		</div>
	{/if}

	<!-- Step 3: Place deck into oven -->
	{#if step === 'place_deck'}
		<div class="space-y-4">
			<div
				class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-3"
			>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">Cooling Tray</p>
				<p class="font-mono text-lg font-semibold text-[var(--color-tron-cyan)]">{trayId}</p>
			</div>
			<div class="rounded-lg border border-green-500/30 bg-green-900/10 px-4 py-3">
				<p class="text-sm font-medium text-green-400">
					Cooling confirmed at {coolingTimestamp?.toLocaleTimeString() ?? ''}
				</p>
			</div>
			<div class="rounded-xl border border-amber-500/50 bg-amber-900/10 p-6 text-center">
				<svg
					class="mx-auto mb-3 h-10 w-10 text-amber-400"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					stroke-width="1.5"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
					/>
				</svg>
				<p class="text-lg font-bold text-amber-300">Place Deck Into the Oven</p>
				<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
					Deck enters <span class="font-semibold text-amber-400">{deckLockoutMin}-minute</span> cooldown
					lockout
				</p>
			</div>
			<button
				type="button"
				onclick={handleDeckPlaced}
				class="min-h-[44px] w-full rounded-lg border border-green-500/50 bg-green-900/20 px-8 py-4 text-lg font-bold text-green-400 transition-all hover:bg-green-900/30"
			>
				Deck Placed in Oven
			</button>
		</div>
	{/if}
</div>
