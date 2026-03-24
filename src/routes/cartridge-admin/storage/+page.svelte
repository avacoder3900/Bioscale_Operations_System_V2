<script lang="ts">
	import { enhance } from '$app/forms';
	import { SvelteMap } from 'svelte/reactivity';
	import { generateTestBarcode } from '$lib/utils/test-barcode';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Scanning workflow state
	let step = $state<'container' | 'fridge' | 'done'>('container');
	let containerBarcode = $state('');
	let selectedFridge = $state<string | null>(null);
	let scanError = $state('');
	let successMessage = $state('');
	let selectedCartridgeIds = $state<string[]>([]);

	// Fridge expansion state
	let expandedFridge = $state<string | null>(null);

	// Dynamic fridges from Equipment collection — no hardcoded list
	const FRIDGES = $derived(data.fridges.map((f: any) => f.barcode || f.id));

	const fridgeLabels = $derived(
		Object.fromEntries(data.fridges.map((f: any) => [f.barcode || f.id, f.displayName]))
	);

	const totalStored = $derived(
		Object.values(data.summary).reduce((a, b) => a + b, 0)
	);

	function focusOnMount(node: HTMLElement) {
		node.focus();
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
			osc.stop(ctx.currentTime + 0.15);
		} catch { /* audio not available */ }
	}

	function handleContainerScan() {
		const value = containerBarcode.trim();
		if (!value) {
			scanError = 'Please scan or enter a container barcode';
			playBeep(false);
			return;
		}

		if (data.awaitingStorage.length === 0) {
			scanError = 'No cartridges are currently awaiting storage';
			playBeep(false);
			return;
		}

		selectedCartridgeIds = data.awaitingStorage.map((c) => c.cartridgeId);
		scanError = '';
		step = 'fridge';
		playBeep(true);
	}

	let fridgeValidating = $state(false);
	let fridgeError = $state('');

	async function selectFridge(fridgeId: string) {
		fridgeError = '';
		fridgeValidating = true;
		try {
			const res = await fetch(`/api/dev/validate-equipment?type=fridge&id=${encodeURIComponent(fridgeId)}`);
			const result = await res.json();
			if (!res.ok || result.error) {
				fridgeError = result.error ?? `Fridge "${fridgeId}" not found in the system.`;
				playBeep(false);
				fridgeValidating = false;
				return;
			}
		} catch {
			// If endpoint unavailable, accept selection (backwards compat)
		}
		fridgeValidating = false;
		selectedFridge = fridgeId;
		playBeep(true);
	}

	function resetWorkflow() {
		step = 'container';
		containerBarcode = '';
		selectedFridge = null;
		scanError = '';
		successMessage = '';
		selectedCartridgeIds = [];
	}

	function handleFormResult(result: { type: string; data?: Record<string, unknown> }) {
		if (result.type === 'success' && result.data?.success) {
			successMessage = (result.data.message as string) ?? 'Cartridges stored successfully';
			step = 'done';
			playBeep(true);
		} else if (result.type === 'failure' && result.data?.error) {
			scanError = result.data.error as string;
			playBeep(false);
		}
	}

	// Group fridge cartridges by container
	function groupByContainer(cartridges: { cartridgeId: string; containerBarcode: string | null; storedAt: string | null; status: string }[]) {
		const groups = new SvelteMap<string, typeof cartridges>();
		for (const c of cartridges) {
			const key = c.containerBarcode ?? 'Unknown';
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(c);
		}
		return groups;
	}
</script>

<div class="space-y-6">
	<!-- Fridge Overview Cards -->
	<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
		{#each FRIDGES as fridge (fridge)}
			{@const count = data.summary[fridge] ?? 0}
			{@const isExpanded = expandedFridge === fridge}
			<button
				type="button"
				onclick={() => { expandedFridge = isExpanded ? null : fridge; }}
				class="rounded-lg border p-4 text-left transition-all {isExpanded
					? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/10'
					: 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] hover:border-[var(--color-tron-cyan)]/50'}"
			>
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-2">
						<svg class="h-5 w-5 text-[var(--color-tron-cyan)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
						</svg>
						<span class="text-sm font-medium text-[var(--color-tron-text)]">{fridgeLabels[fridge]}</span>
					</div>
					<span class="rounded-full px-2.5 py-0.5 text-sm font-bold {count > 0
						? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]'
						: 'bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)]'}"
					>
						{count}
					</span>
				</div>
				<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
					{count === 1 ? '1 cartridge' : `${count} cartridges`}
				</p>
				<svg class="mt-1 h-4 w-4 transition-transform text-[var(--color-tron-text-secondary)] {isExpanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
				</svg>
			</button>
		{/each}
	</div>

	<!-- Fridge Detail (expanded) -->
	{#if expandedFridge}
		{@const cartridges = data.fridgeDetails[expandedFridge as keyof typeof data.fridgeDetails] ?? []}
		{@const groups = groupByContainer(cartridges)}
		<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)] p-4">
			<h3 class="mb-3 text-sm font-medium text-[var(--color-tron-cyan)]">
				{fridgeLabels[expandedFridge]} Contents
			</h3>
			{#if cartridges.length === 0}
				<p class="text-sm text-[var(--color-tron-text-secondary)]">No cartridges stored in this fridge</p>
			{:else}
				{#each [...groups.entries()] as [container, items] (container)}
					<div class="mb-3 last:mb-0">
						<div class="flex items-center gap-2 mb-1">
							<span class="font-mono text-xs text-[var(--color-tron-cyan)]">{container}</span>
							<span class="rounded-full bg-[var(--color-tron-surface)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">
								{items.length}
							</span>
						</div>
						<div class="ml-4 grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4">
							{#each items as item (item.cartridgeId)}
								<div class="rounded border border-[var(--color-tron-border)]/50 px-2 py-1 text-xs">
									<span class="font-mono text-[var(--color-tron-text)]">{item.cartridgeId}</span>
								</div>
							{/each}
						</div>
					</div>
				{/each}
			{/if}
		</div>
	{/if}

	<!-- Summary Bar -->
	<div class="flex items-center justify-between rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-2">
		<span class="text-sm text-[var(--color-tron-text-secondary)]">
			<span class="font-bold text-[var(--color-tron-cyan)]">{totalStored}</span> total stored |
			<span class="font-bold text-[var(--color-tron-yellow)]">{data.awaitingStorage.length}</span> awaiting storage
		</span>
	</div>

	<!-- Scanning Workflow -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6">
		<h2 class="mb-4 text-lg font-semibold text-[var(--color-tron-text)]">Storage Scanning</h2>

		<!-- Step indicators -->
		<div class="mb-6 flex items-center gap-2">
			<div class="flex items-center gap-1">
				<div class="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold {step === 'container'
					? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg)]'
					: 'bg-emerald-600 text-white'}"
				>
					{step === 'container' ? '1' : '\u2713'}
				</div>
				<span class="text-xs text-[var(--color-tron-text-secondary)]">Scan Container</span>
			</div>
			<div class="h-px flex-1 bg-[var(--color-tron-border)]"></div>
			<div class="flex items-center gap-1">
				<div class="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold {step === 'fridge'
					? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg)]'
					: step === 'done'
						? 'bg-emerald-600 text-white'
						: 'bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] border border-[var(--color-tron-border)]'}"
				>
					{step === 'done' ? '\u2713' : '2'}
				</div>
				<span class="text-xs text-[var(--color-tron-text-secondary)]">Select Fridge</span>
			</div>
		</div>

		<!-- Error display -->
		{#if scanError}
			<div class="mb-4 rounded border border-[var(--color-tron-error)]/50 bg-[var(--color-tron-error)]/10 px-4 py-2 text-sm text-[var(--color-tron-error)]">
				{scanError}
			</div>
		{/if}

		<!-- Step 1: Container Scan -->
		{#if step === 'container'}
			<div class="space-y-4">
				<p class="text-sm text-[var(--color-tron-text-secondary)]">
					Scan the barcode on the deck, tray, or bucket to identify the container.
				</p>
				<div class="flex gap-2">
					<input
						use:focusOnMount
						bind:value={containerBarcode}
						onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleContainerScan(); } }}
						placeholder="Scan container barcode..."
						class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-4 py-2 font-mono text-sm text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/50 focus:border-[var(--color-tron-cyan)] focus:outline-none"
					/>
					<button
						type="button"
						onclick={handleContainerScan}
						class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-2 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/30"
					>
						Scan
					</button>
					<button
						type="button"
						onclick={() => { containerBarcode = generateTestBarcode('CONT'); handleContainerScan(); }}
						class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]"
					>
						Test
					</button>
				</div>
				{#if data.awaitingStorage.length > 0}
					<p class="text-xs text-[var(--color-tron-text-secondary)]">
						{data.awaitingStorage.length} cartridge{data.awaitingStorage.length !== 1 ? 's' : ''} ready for storage
					</p>
				{:else}
					<p class="text-xs text-[var(--color-tron-yellow)]">
						No cartridges currently awaiting storage
					</p>
				{/if}
			</div>
		{/if}

		<!-- Step 2: Fridge Selection -->
		{#if step === 'fridge'}
			<div class="space-y-4">
				<div class="flex items-center gap-2">
					<span class="text-sm text-[var(--color-tron-text-secondary)]">Container:</span>
					<span class="rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 px-2 py-0.5 font-mono text-sm text-[var(--color-tron-cyan)]">
						{containerBarcode}
					</span>
					<span class="text-sm text-[var(--color-tron-text-secondary)]">
						({selectedCartridgeIds.length} cartridge{selectedCartridgeIds.length !== 1 ? 's' : ''})
					</span>
				</div>

				<p class="text-sm text-[var(--color-tron-text-secondary)]">
					Select the fridge to store these cartridges:
				</p>
				{#if fridgeError}
					<p class="text-sm text-red-400">{fridgeError}</p>
				{/if}

				<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
					{#each FRIDGES as fridge (fridge)}
						{@const count = data.summary[fridge] ?? 0}
						<button
							type="button"
							onclick={() => selectFridge(fridge)}
							class="rounded-lg border-2 p-4 text-center transition-all {selectedFridge === fridge
								? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/20 shadow-[0_0_12px_rgba(0,255,255,0.2)]'
								: 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] hover:border-[var(--color-tron-cyan)]/50'}"
						>
							<div class="text-2xl font-bold text-[var(--color-tron-text)]">{fridge.replace('fridge-', '')}</div>
							<div class="text-xs text-[var(--color-tron-text-secondary)]">{fridgeLabels[fridge]}</div>
							<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">{count} stored</div>
						</button>
					{/each}
				</div>

				{#if selectedFridge}
					<form
						method="POST"
						action="?/store"
						use:enhance={() => {
							return async ({ result, update }) => {
								handleFormResult(result as { type: string; data?: Record<string, unknown> });
								await update();
							};
						}}
					>
						<input type="hidden" name="containerBarcode" value={containerBarcode} />
						<input type="hidden" name="fridgeId" value={selectedFridge} />
						<input type="hidden" name="cartridgeIds" value={selectedCartridgeIds.join(',')} />
						<div class="flex items-center gap-3">
							<button
								type="submit"
								class="min-h-[44px] flex-1 rounded border border-emerald-500/50 bg-emerald-900/20 px-6 py-3 text-sm font-semibold text-emerald-300 transition-colors hover:bg-emerald-900/40"
							>
								Store {selectedCartridgeIds.length} Cartridge{selectedCartridgeIds.length !== 1 ? 's' : ''} in {fridgeLabels[selectedFridge]}
							</button>
							<button
								type="button"
								onclick={resetWorkflow}
								class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-4 py-3 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text)]"
							>
								Cancel
							</button>
						</div>
					</form>
				{/if}
			</div>
		{/if}

		<!-- Done State -->
		{#if step === 'done'}
			<div class="space-y-4 text-center">
				<div class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-900/30 text-3xl text-emerald-400">
					&#10003;
				</div>
				<p class="text-lg font-semibold text-emerald-300">{successMessage}</p>
				<button
					type="button"
					onclick={resetWorkflow}
					class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-8 py-2 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/30"
				>
					Scan Next Container
				</button>
			</div>
		{/if}
	</div>
</div>
