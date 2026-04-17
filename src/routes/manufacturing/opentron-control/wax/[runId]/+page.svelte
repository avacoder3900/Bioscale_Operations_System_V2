<script lang="ts">
	import PostRunCooling from '$lib/components/manufacturing/wax-filling/PostRunCooling.svelte';
	import QCInspection from '$lib/components/manufacturing/wax-filling/QCInspection.svelte';
	import CompletionStorage from '$lib/components/manufacturing/wax-filling/CompletionStorage.svelte';

	let { data, form } = $props();

	const STAGES = ['Cooling', 'QC', 'Storage'] as const;
	let currentStageIndex = $derived(
		data.stage === 'Awaiting Removal' ? 0 :
		data.stage === 'QC' ? 1 :
		data.stage === 'Storage' ? 2 : 0
	);

	// Oven scan state — shown after PostRunCooling completes, before confirmCooling
	let showOvenScan = $state(false);
	let ovenScanInput = $state('');
	let ovenScanError = $state('');
	let ovenScanValidating = $state(false);
	let ovenScanResult = $state<{ id: string; name: string } | null>(null);
	let coolingTrayId = $state('');

	let coolingBypassed = $state(false);
	let coolingBypassPassword = $state('');
	let coolingBypassError = $state('');
	let showCoolingBypass = $state(false);

	let coolingComplete = $derived(() => {
		if (coolingBypassed) return true;
		if (!data.runState.coolingConfirmedAt) return false;
		const elapsed = Date.now() - new Date(data.runState.coolingConfirmedAt).getTime();
		return elapsed >= 10 * 60 * 1000;
	});

	let coolingCountdown = $derived(() => {
		if (!data.runState.coolingConfirmedAt) return '10:00';
		const elapsed = Date.now() - new Date(data.runState.coolingConfirmedAt).getTime();
		const remaining = Math.max(0, 10 * 60 * 1000 - elapsed);
		const m = Math.floor(remaining / 60000);
		const s = Math.floor((remaining % 60000) / 1000);
		return `${m}:${String(s).padStart(2, '0')}`;
	});

	function submitForm(action: string, extra: Record<string, string> = {}) {
		const f = document.createElement('form');
		f.method = 'POST';
		f.action = `?/${action}`;
		f.style.display = 'none';

		const addField = (name: string, value: string) => {
			const input = document.createElement('input');
			input.type = 'hidden';
			input.name = name;
			input.value = value;
			f.appendChild(input);
		};

		addField('runId', data.runId);
		for (const [k, v] of Object.entries(extra)) addField(k, v);

		document.body.appendChild(f);
		f.submit();
	}

	function handleCoolingComplete(result?: { trayId?: string }) {
		// PostRunCooling finished — now scan the curing oven before advancing
		coolingTrayId = result?.trayId ?? '';
		showOvenScan = true;
		ovenScanInput = '';
		ovenScanError = '';
		ovenScanResult = null;
	}

	async function handleOvenScanKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter' || !ovenScanInput.trim()) return;
		e.preventDefault();
		const value = ovenScanInput.trim();
		ovenScanInput = '';
		ovenScanError = '';
		ovenScanValidating = true;
		try {
			const res = await fetch(`/api/dev/validate-equipment?type=oven&id=${encodeURIComponent(value)}`);
			const result = await res.json();
			if (!res.ok || result.error) {
				ovenScanError = result.error ?? `Oven "${value}" not found.`;
			} else {
				ovenScanResult = { id: result.id ?? value, name: result.name ?? value };
			}
		} catch {
			ovenScanError = 'Validation failed';
		} finally {
			ovenScanValidating = false;
		}
	}

	function confirmOvenAndAdvance() {
		if (!ovenScanResult) return;
		showOvenScan = false;
		submitForm('confirmCooling', {
			coolingTrayId,
			ovenLocationId: ovenScanResult.id,
			ovenLocationName: ovenScanResult.name
		});
	}

	function handleQCComplete() {
		submitForm('completeQC');
	}

	function handleRecordStorage(cartridgeIds: string[], location: string) {
		submitForm('recordBatchStorage', {
			cartridgeIds: JSON.stringify(cartridgeIds),
			storageLocation: location,
			coolingTrayId: data.runState.coolingTrayId ?? ''
		});
	}

	function handleCompleteRun() {
		submitForm('completeRun');
	}

	async function handleCoolingBypass() {
		try {
			const res = await fetch(`/api/dev/validate-equipment?type=admin-password&id=${coolingBypassPassword}`);
			const json = await res.json();
			if (json.valid) {
				coolingBypassed = true;
				coolingBypassError = '';
			} else {
				coolingBypassError = json.error || 'Invalid password';
			}
		} catch {
			coolingBypassError = 'Network error';
		}
	}
</script>

<div class="mx-auto max-w-5xl space-y-6 p-4">
	<div class="flex items-center gap-3">
		<a href="/manufacturing/opentron-control"
			class="flex items-center justify-center rounded"
			style="min-height: 44px; min-width: 44px; color: var(--color-tron-text-secondary)">
			&#8592;
		</a>
		<div>
			<h1 class="text-xl font-bold" style="color: var(--color-tron-cyan)">Wax Post-Processing</h1>
			<p class="text-xs" style="color: var(--color-tron-text-secondary)">
				Run {data.runId.slice(-8)} &middot; {data.robotName} &middot;
				{data.runState.plannedCartridgeCount ?? '?'} cartridges
			</p>
		</div>
	</div>

	{#if form?.error}
		<div class="rounded-lg border border-red-500/50 bg-red-900/20 p-3 text-sm text-red-300">{form.error}</div>
	{/if}

	<!-- Step indicator -->
	<div class="flex items-center gap-2">
		{#each STAGES as stage, i (stage)}
			{@const isCurrent = i === currentStageIndex}
			{@const isPast = i < currentStageIndex}
			<div class="flex items-center gap-2">
				<div class="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold
					{isCurrent ? 'bg-[var(--color-tron-cyan)] text-black' :
					 isPast ? 'bg-green-500/30 text-green-300' :
					 'bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)]'}">
					{#if isPast}&#10003;{:else}{i + 4}{/if}
				</div>
				<span class="text-xs {isCurrent ? 'font-bold text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)]'}">{stage}</span>
			</div>
			{#if i < STAGES.length - 1}
				<div class="h-px flex-1 {isPast ? 'bg-green-500/30' : 'bg-[var(--color-tron-border)]'}"></div>
			{/if}
		{/each}
	</div>

	<!-- Stage content -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-5">
		{#if data.stage === 'Awaiting Removal'}
			<PostRunCooling
				runEndTime={data.runState.deckRemovedTime ? new Date(data.runState.deckRemovedTime) : new Date()}
				coolingWarningMin={data.settings.coolingWarningMin}
				deckLockoutMin={data.settings.deckLockoutMin}
				onComplete={handleCoolingComplete}
				readonly={false}
			/>
		{:else if data.stage === 'QC'}
			{@const qcCarts = data.qcCartridges.map((c) => ({
				...c,
				ovenEntryTime: c.ovenEntryTime ? new Date(c.ovenEntryTime) : null,
				qcTimestamp: c.qcTimestamp ? new Date(c.qcTimestamp) : null,
				storageTimestamp: c.storageTimestamp ? new Date(c.storageTimestamp) : null,
				createdAt: new Date(c.createdAt),
				updatedAt: new Date(c.updatedAt)
			}))}
			{#if !coolingComplete}
				<div class="rounded-lg border border-blue-500/50 bg-blue-900/20 p-5 text-center">
					<p class="text-sm font-medium text-blue-300">Cooling in progress — inspection locked</p>
					<p class="mt-2 font-mono text-3xl font-bold text-blue-200">Cooling: {coolingCountdown} remaining</p>
					<p class="mt-2 text-xs text-blue-400/70">Cartridges must cool for 10 minutes before QC inspection can begin.</p>
					{#if !showCoolingBypass}
						<button type="button" onclick={() => { showCoolingBypass = true; }} class="mt-3 text-xs text-blue-400/50 hover:text-blue-300 transition-colors">
							Admin Override
						</button>
					{:else}
						<div class="mt-3 flex items-center justify-center gap-2">
							<input type="password" bind:value={coolingBypassPassword} placeholder="Admin password..."
								class="rounded border border-blue-500/30 bg-blue-900/30 px-3 py-1.5 text-sm text-blue-200 placeholder:text-blue-400/40 focus:border-blue-400 focus:outline-none"
								onkeydown={(e) => { if (e.key === 'Enter') handleCoolingBypass(); }} />
							<button type="button" onclick={handleCoolingBypass} class="rounded bg-blue-500/20 px-3 py-1.5 text-sm text-blue-300 hover:bg-blue-500/30">Bypass</button>
						</div>
						{#if coolingBypassError}
							<p class="mt-1 text-xs text-red-400">{coolingBypassError}</p>
						{/if}
					{/if}
				</div>
			{:else if qcCarts.length > 0}
				<QCInspection
					cartridges={qcCarts}
					rejectionCodes={data.rejectionCodes}
					onComplete={handleQCComplete}
					readonly={false}
					coolingConfirmedAt={data.runState.coolingConfirmedAt ? new Date(data.runState.coolingConfirmedAt) : null}
					{coolingBypassed}
					runId={data.runId}
					lotId={null}
				/>
			{:else}
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center">
					<p class="text-sm" style="color: var(--color-tron-text-secondary)">No cartridges found for QC inspection.</p>
				</div>
			{/if}
		{:else if data.stage === 'Storage'}
			{@const summary = {
				runId: data.runId,
				cartridgeCount: data.storageCartridges.length,
				acceptedCount: data.storageCartridges.filter((c) => c.qcStatus === 'Accepted').length,
				rejectedCount: data.storageCartridges.filter((c) => c.qcStatus === 'Rejected').length
			}}
			<CompletionStorage
				cartridges={data.storageCartridges}
				runSummary={summary}
				fridges={data.fridges}
				onRecordStorage={handleRecordStorage}
				onComplete={handleCompleteRun}
				readonly={false}
			/>
		{/if}
	</div>
</div>

<!-- Oven Scan Modal — shown after PostRunCooling completes, before advancing to QC -->
{#if showOvenScan}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
		<div class="mx-4 w-full max-w-md rounded-lg border border-amber-500/50 bg-[var(--color-tron-surface)] p-6 shadow-xl">
			<h3 class="text-lg font-semibold text-amber-300">Place Deck in Oven</h3>
			<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
				Scan the oven barcode where the deck will be placed for post-wax curing.
			</p>

			{#if !ovenScanResult}
				<div class="mt-4">
					<input
						type="text"
						bind:value={ovenScanInput}
						onkeydown={handleOvenScanKeydown}
						placeholder="Scan oven barcode..."
						disabled={ovenScanValidating}
						class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)] focus:border-amber-400 focus:outline-none"
					/>
					{#if ovenScanError}
						<p class="mt-2 text-sm text-red-400">{ovenScanError}</p>
					{/if}
					{#if ovenScanValidating}
						<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">Validating...</p>
					{/if}
				</div>
			{:else}
				<div class="mt-4 rounded-lg border border-green-500/30 bg-green-900/10 p-4">
					<p class="text-sm text-green-400">Oven verified:</p>
					<p class="mt-1 font-mono text-lg font-bold text-green-300">{ovenScanResult.name}</p>
				</div>
				<button
					type="button"
					onclick={confirmOvenAndAdvance}
					class="mt-4 min-h-[44px] w-full rounded-lg border border-green-500/50 bg-green-900/20 px-6 py-3 text-sm font-bold text-green-300 transition-all hover:bg-green-900/30"
				>
					Confirm — Deck Placed in {ovenScanResult.name}
				</button>
			{/if}

			<button
				type="button"
				onclick={() => { showOvenScan = false; }}
				class="mt-3 w-full rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-border)]/30"
			>
				Cancel
			</button>
		</div>
	</div>
{/if}
