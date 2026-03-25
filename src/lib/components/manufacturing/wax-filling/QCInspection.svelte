<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import type { WaxCartridgeRecord, RejectionReasonCode } from '$lib/server/db/schema';

	const COOLING_GATE_MIN = 10;

	interface Props {
		cartridges: WaxCartridgeRecord[];
		rejectionCodes: RejectionReasonCode[];
		onComplete: (data: { rejectedCartridges: { cartridgeId: string; reasonCode: string }[] }) => void;
		readonly?: boolean;
		coolingConfirmedAt?: Date | null;
		coolingBypassed?: boolean;
	}

	let { cartridges, rejectionCodes, onComplete, readonly: isReadonly = false, coolingConfirmedAt = null, coolingBypassed = false }: Props = $props();

	let rejected = new SvelteMap<string, string>();
	let scanInput = $state('');
	let selectedCartridgeId = $state<string | null>(null);
	let selectedReasonCode = $state('');
	let error = $state('');
	let inputEl: HTMLInputElement | undefined = $state();

	// 10-minute cooling gate
	let coolTick = $state(0);
	$effect(() => {
		if (!coolingConfirmedAt || coolingBypassed) return;
		const interval = setInterval(() => { coolTick++; }, 1000);
		return () => clearInterval(interval);
	});
	const coolingElapsedMs = $derived.by(() => {
		void coolTick;
		if (coolingBypassed) return COOLING_GATE_MIN * 60_000;
		return coolingConfirmedAt ? Date.now() - coolingConfirmedAt.getTime() : Infinity;
	});
	const coolingRemainingMs = $derived(Math.max(0, COOLING_GATE_MIN * 60_000 - coolingElapsedMs));
	const coolingGateBlocked = $derived(coolingRemainingMs > 0);
	const coolingRemainingDisplay = $derived(() => {
		const totalSec = Math.ceil(coolingRemainingMs / 1000);
		const min = Math.floor(totalSec / 60);
		const sec = totalSec % 60;
		return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
	});

	const acceptedIds = $derived(
		cartridges.filter((c) => !rejected.has(c.cartridgeId)).map((c) => c.cartridgeId)
	);

	$effect(() => {
		if (!selectedCartridgeId && inputEl) inputEl.focus();
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
		} catch { /* Audio not supported */ }
	}

	function handleScan(e: KeyboardEvent) {
		if (e.key !== 'Enter' || !scanInput.trim()) return;
		e.preventDefault();
		const scanned = scanInput.trim();
		scanInput = '';

		const match = cartridges.find((c) => c.cartridgeId === scanned);
		if (!match) {
			error = `Cartridge "${scanned}" not found on this tray`;
			playBeep(false);
			return;
		}
		if (rejected.has(scanned)) {
			error = `Cartridge "${scanned}" is already rejected`;
			playBeep(false);
			return;
		}

		error = '';
		selectedCartridgeId = scanned;
		playBeep(true);
	}

	function handleInputBlur() {
		if (!selectedCartridgeId) setTimeout(() => inputEl?.focus(), 100);
	}

	function confirmRejection() {
		if (!selectedCartridgeId || !selectedReasonCode) return;
		rejected.set(selectedCartridgeId, selectedReasonCode);
		selectedCartridgeId = null;
		selectedReasonCode = '';
	}

	function cancelRejection() {
		selectedCartridgeId = null;
		selectedReasonCode = '';
		error = '';
	}

	function undoRejection(cartridgeId: string) {
		rejected.delete(cartridgeId);
	}

	function handleComplete() {
		const rejectedCartridges = [...rejected.entries()].map(([cartridgeId, reasonCode]) => ({
			cartridgeId,
			reasonCode
		}));
		onComplete({ rejectedCartridges });
	}

	function getReasonLabel(code: string): string {
		return rejectionCodes.find((r) => r.code === code)?.label ?? code;
	}
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">QC Inspection</h2>

	<!-- Cooling gate: block QC until cartridges have cooled for 10 minutes -->
	{#if coolingGateBlocked}
		<div class="rounded-lg border border-amber-500/50 bg-amber-900/20 p-6 text-center">
			<svg class="mx-auto mb-3 h-10 w-10 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
			</svg>
			<p class="text-lg font-bold text-amber-300">Cartridges Still Cooling</p>
			<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
				Cartridges must cool for at least {COOLING_GATE_MIN} minutes before QC inspection.
			</p>
			<p class="mt-4 font-mono text-4xl font-bold text-amber-400">{coolingRemainingDisplay()}</p>
			<p class="mt-1 text-xs text-amber-400/70">remaining</p>
		</div>
	{/if}

	<!-- Summary -->
	<div class="grid grid-cols-3 gap-3">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Total</p>
			<p class="text-xl font-bold text-[var(--color-tron-cyan)]">{cartridges.length}</p>
		</div>
		<div class="rounded-lg border border-green-500/30 bg-green-900/10 px-3 py-2 text-center">
			<p class="text-xs text-green-400/70">Accepted</p>
			<p class="text-xl font-bold text-green-400">{acceptedIds.length}</p>
		</div>
		<div class="rounded-lg border border-red-500/30 bg-red-900/10 px-3 py-2 text-center">
			<p class="text-xs text-red-400/70">Rejected</p>
			<p class="text-xl font-bold text-red-400">{rejected.size}</p>
		</div>
	</div>

	<!-- Reject by scan -->
	{#if selectedCartridgeId}
		<div class="space-y-3 rounded-lg border border-red-500/50 bg-red-900/10 p-4">
			<p class="text-sm font-medium text-red-300">
				Rejecting: <span class="font-mono font-bold">{selectedCartridgeId}</span>
			</p>
			<label for="reason-select" class="block text-xs text-[var(--color-tron-text-secondary)]">Select Rejection Reason</label>
			<select
				id="reason-select"
				bind:value={selectedReasonCode}
				class="min-h-[44px] w-full rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
			>
				<option value="">-- Select reason --</option>
				{#each rejectionCodes as code (code.code)}
					<option value={code.code}>{code.code}: {code.label}</option>
				{/each}
			</select>
			<div class="flex gap-2">
				<button
					type="button"
					disabled={!selectedReasonCode}
					onclick={confirmRejection}
					class="min-h-[44px] flex-1 rounded-lg border px-4 py-2 text-sm font-semibold transition-all {selectedReasonCode
						? 'border-red-500/50 bg-red-900/20 text-red-400 hover:bg-red-900/30'
						: 'cursor-not-allowed border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] opacity-50'}"
				>
					Confirm Rejection
				</button>
				<button
					type="button"
					onclick={cancelRejection}
					class="min-h-[44px] rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface-hover)]"
				>
					Cancel
				</button>
			</div>
		</div>
	{:else}
		<div class="space-y-2">
			<label for="qc-scan" class="block text-xs text-[var(--color-tron-text-secondary)]">
				Scan cartridge barcode to reject it
			</label>
			<div class="flex gap-2">
				<input
					bind:this={inputEl}
					id="qc-scan"
					type="text"
					class="tron-input flex-1"
					placeholder="Scan cartridge barcode to reject..."
					bind:value={scanInput}
					onkeydown={handleScan}
					onblur={handleInputBlur}
					autocomplete="off"
				/>
				{#if acceptedIds.length > 0}
					<button
						type="button"
						onclick={() => { scanInput = acceptedIds[0]; handleScan(new KeyboardEvent('keydown', { key: 'Enter' })); }}
						class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]"
					>
						Test (use first)
					</button>
				{/if}
			</div>
			{#if error}
				<p class="text-xs text-red-400">{error}</p>
			{/if}
		</div>
	{/if}

	<!-- Cartridge grid -->
	<div class="grid grid-cols-4 gap-2 sm:grid-cols-6">
		{#each cartridges as c (c.cartridgeId)}
			{@const isRejected = rejected.has(c.cartridgeId)}
			<div
				class="relative rounded-lg border px-2 py-2 text-center {isRejected
					? 'border-red-500/50 bg-red-900/20'
					: 'border-green-500/30 bg-green-900/10'}"
			>
				<p class="truncate font-mono text-xs font-medium {isRejected ? 'text-red-300' : 'text-green-300'}">
					{c.cartridgeId.length > 8 ? c.cartridgeId.slice(-8) : c.cartridgeId}
				</p>
				{#if isRejected}
					<p class="mt-0.5 truncate text-[10px] text-red-400/70">
						{getReasonLabel(rejected.get(c.cartridgeId) ?? '')}
					</p>
					<button
						type="button"
						onclick={() => undoRejection(c.cartridgeId)}
						class="mt-1 text-[10px] text-red-400 underline hover:text-red-300"
					>
						Undo
					</button>
				{:else}
					<p class="mt-0.5 text-[10px] text-green-400/70">Accepted</p>
				{/if}
			</div>
		{/each}
	</div>

	<!-- Complete QC -->
	<button
		type="button"
		onclick={handleComplete}
		disabled={coolingGateBlocked}
		class="min-h-[44px] w-full rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30 disabled:cursor-not-allowed disabled:opacity-40"
	>
		{coolingGateBlocked ? `Complete QC (cooling: ${coolingRemainingDisplay()})` : `Complete QC (${acceptedIds.length} accepted, ${rejected.size} rejected)`}
	</button>
</div>
