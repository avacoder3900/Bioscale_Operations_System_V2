<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';

	interface CartridgeItem {
		id: string;
		cartridgeId: string;
		deckPosition: number;
		inspectionStatus: string;
		inspectionReason: string | null;
	}

	interface RejectionCode {
		code: string;
		label: string;
	}

	interface Props {
		cartridges: CartridgeItem[];
		rejectionCodes: RejectionCode[];
		onComplete: (data: { rejectedCartridges: { cartridgeRecordId: string; reasonCode: string }[] }) => void;
		readonly?: boolean;
		focusPaused?: boolean;
	}

	let { cartridges, rejectionCodes, onComplete, readonly: isReadonly = false, focusPaused = false }: Props = $props();

	let rejected = new SvelteMap<string, { recordId: string; reasonCode: string }>();
	let scanInput = $state('');
	let selectedCartridgeId = $state<string | null>(null);
	let selectedRecordId = $state<string | null>(null);
	let selectedReasonCode = $state('');
	let error = $state('');
	let inputEl: HTMLInputElement | undefined = $state();

	// Only look at cartridges that haven't been already inspected (still "Pending")
	const pendingCartridges = $derived(
		cartridges.filter((c) => c.inspectionStatus === 'Pending')
	);

	const acceptedIds = $derived(
		pendingCartridges.filter((c) => !rejected.has(c.cartridgeId)).map((c) => c.cartridgeId)
	);

	// Already-inspected cartridges from previous sessions
	const alreadyAccepted = $derived(cartridges.filter((c) => c.inspectionStatus === 'Accepted'));
	const alreadyRejected = $derived(cartridges.filter((c) => c.inspectionStatus === 'Rejected'));

	$effect(() => {
		if (!selectedCartridgeId && inputEl && !focusPaused) inputEl.focus();
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

	function handleScan(e: KeyboardEvent) {
		if (e.key !== 'Enter' || !scanInput.trim()) return;
		e.preventDefault();
		const scanned = scanInput.trim();
		scanInput = '';

		const match = pendingCartridges.find((c) => c.cartridgeId === scanned);
		if (!match) {
			const alreadyDone = cartridges.find((c) => c.cartridgeId === scanned);
			if (alreadyDone) {
				error = `Cartridge already inspected: ${alreadyDone.inspectionStatus}`;
			} else {
				error = `Cartridge "${scanned}" not found in this run`;
			}
			playBeep(false);
			return;
		}
		if (rejected.has(scanned)) {
			error = `Cartridge "${scanned}" is already marked for rejection`;
			playBeep(false);
			return;
		}

		error = '';
		selectedCartridgeId = scanned;
		selectedRecordId = match.id;
		playBeep(true);
	}

	function handleInputBlur() {
		if (!selectedCartridgeId && !focusPaused) setTimeout(() => inputEl?.focus(), 100);
	}

	function confirmRejection() {
		if (!selectedCartridgeId || !selectedRecordId || !selectedReasonCode) return;
		rejected.set(selectedCartridgeId, { recordId: selectedRecordId, reasonCode: selectedReasonCode });
		selectedCartridgeId = null;
		selectedRecordId = null;
		selectedReasonCode = '';
	}

	function cancelRejection() {
		selectedCartridgeId = null;
		selectedRecordId = null;
		selectedReasonCode = '';
		error = '';
	}

	function undoRejection(cartridgeId: string) {
		rejected.delete(cartridgeId);
	}

	function handleComplete() {
		const rejectedCartridges = [...rejected.entries()].map(([, data]) => ({
			cartridgeRecordId: data.recordId,
			reasonCode: data.reasonCode
		}));
		onComplete({ rejectedCartridges });
	}

	function getReasonLabel(code: string): string {
		return rejectionCodes.find((r) => r.code === code)?.label ?? code;
	}
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Inspection</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Scan cartridges to reject them. All unscanned cartridges will be accepted.
	</p>

	{#if isReadonly}
		<p class="rounded border border-[var(--color-tron-yellow)]/30 bg-[var(--color-tron-yellow)]/5 px-3 py-2 text-xs text-[var(--color-tron-yellow)]">Read-only — viewing past stage</p>
	{/if}

	<!-- Summary -->
	<div class="grid grid-cols-3 gap-3">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Total</p>
			<p class="text-xl font-bold text-[var(--color-tron-cyan)]">{pendingCartridges.length}</p>
		</div>
		<div class="rounded-lg border border-green-500/30 bg-green-900/10 px-3 py-2 text-center">
			<p class="text-xs text-green-400/70">Will Accept</p>
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
					class="min-h-[44px] rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]"
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

	<!-- Already-inspected cartridges from previous sessions -->
	{#if alreadyAccepted.length > 0 || alreadyRejected.length > 0}
		<div class="rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-surface)] p-3 text-xs text-[var(--color-tron-text-secondary)]">
			Previously inspected: {alreadyAccepted.length} accepted, {alreadyRejected.length} rejected
		</div>
	{/if}

	<!-- Cartridge grid -->
	<div class="grid grid-cols-4 gap-2 sm:grid-cols-6">
		{#each pendingCartridges as c (c.cartridgeId)}
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
						{getReasonLabel(rejected.get(c.cartridgeId)?.reasonCode ?? '')}
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

	<!-- Complete Inspection -->
	<button
		type="button"
		onclick={handleComplete}
		disabled={isReadonly}
		class="min-h-[44px] w-full rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30 disabled:cursor-not-allowed disabled:opacity-50"
	>
		Complete Inspection ({acceptedIds.length} accepted, {rejected.size} rejected)
	</button>
</div>
