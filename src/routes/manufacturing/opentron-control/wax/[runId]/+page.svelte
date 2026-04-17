<script lang="ts">
	import QCInspection from '$lib/components/manufacturing/wax-filling/QCInspection.svelte';
	import CompletionStorage from '$lib/components/manufacturing/wax-filling/CompletionStorage.svelte';

	let { data, form } = $props();

	const STAGES = ['QC', 'Storage'] as const;
	let currentStageIndex = $derived(
		data.stage ? STAGES.indexOf(data.stage as typeof STAGES[number]) : 0
	);

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
		const form = document.createElement('form');
		form.method = 'POST';
		form.action = `?/${action}`;
		form.style.display = 'none';

		const addField = (name: string, value: string) => {
			const input = document.createElement('input');
			input.type = 'hidden';
			input.name = name;
			input.value = value;
			form.appendChild(input);
		};

		addField('runId', data.runId);
		for (const [k, v] of Object.entries(extra)) addField(k, v);

		document.body.appendChild(form);
		form.submit();
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
	<!-- Header -->
	<div class="flex items-center gap-3">
		<a href="/manufacturing/opentron-control"
			class="flex items-center justify-center rounded"
			style="min-height: 44px; min-width: 44px; color: var(--color-tron-text-secondary)">
			&#8592;
		</a>
		<div>
			<h1 class="text-xl font-bold" style="color: var(--color-tron-cyan)">
				Wax Post-Processing
			</h1>
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
					{#if isPast}&#10003;{:else}{i + 5}{/if}
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
		{#if data.stage === 'QC'}
			{@const qcCarts = data.qcCartridges.map((c: any) => ({
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
				acceptedCount: data.storageCartridges.filter((c: any) => c.qcStatus === 'Accepted').length,
				rejectedCount: data.storageCartridges.filter((c: any) => c.qcStatus === 'Rejected').length
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
