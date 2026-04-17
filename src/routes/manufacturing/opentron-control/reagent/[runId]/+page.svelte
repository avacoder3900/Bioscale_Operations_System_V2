<script lang="ts">
	import Inspection from '$lib/components/manufacturing/reagent-filling/Inspection.svelte';
	import TopSealing from '$lib/components/manufacturing/reagent-filling/TopSealing.svelte';
	import CompletionStorage from '$lib/components/manufacturing/reagent-filling/CompletionStorage.svelte';

	let { data, form } = $props();

	const STAGES = ['Inspection', 'Top Sealing', 'Storage'] as const;
	let currentStageIndex = $derived(
		data.stage ? STAGES.indexOf(data.stage as typeof STAGES[number]) : 0
	);

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

	// Inspection expects CartridgeItem = { id, cartridgeId, deckPosition, inspectionStatus, inspectionReason }
	const inspectionCartridges = $derived(
		data.cartridgesFilled.map((c: any) => ({
			id: c.cartridgeId,
			cartridgeId: c.cartridgeId,
			deckPosition: c.deckPosition ?? 0,
			inspectionStatus: c.inspectionStatus ?? 'Pending',
			inspectionReason: c.inspectionReason ?? null
		}))
	);

	// TopSealing expects CartridgeItem = { id, cartridgeId, deckPosition }
	const sealCartridges = $derived(
		data.cartridgesFilled
			.filter((c: any) => c.inspectionStatus === 'Accepted')
			.map((c: any) => ({
				id: c.cartridgeId,
				cartridgeId: c.cartridgeId,
				deckPosition: c.deckPosition ?? 0
			}))
	);

	// Build current batch from sealBatches (find the in-progress one)
	const currentBatch = $derived(() => {
		const inProgress = data.sealBatches.find((b: any) => b.status === 'in_progress');
		if (!inProgress) return null;
		return {
			batchId: inProgress.batchId,
			topSealLotId: inProgress.topSealLotId,
			scannedCount: inProgress.cartridgeIds?.length ?? 0,
			totalTarget: sealCartridges.length,
			firstScanTime: null as Date | null,
			elapsedSeconds: 0
		};
	});

	// CompletionStorage expects CartridgeItem = { id, cartridgeId, inspectionStatus, currentStatus, storageLocation }
	const storageCartridges = $derived(
		data.cartridgesFilled
			.filter((c: any) => c.inspectionStatus === 'Accepted')
			.map((c: any) => ({
				id: c.cartridgeId,
				cartridgeId: c.cartridgeId,
				inspectionStatus: c.inspectionStatus ?? 'Accepted',
				currentStatus: c.storageLocation ? 'stored' : 'sealed',
				storageLocation: c.storageLocation ?? null
			}))
	);

	function handleInspectionComplete(result: { rejectedCartridges: { cartridgeRecordId: string; reasonCode: string }[] }) {
		const mapped = result.rejectedCartridges.map((r) => ({
			cartridgeId: r.cartridgeRecordId,
			reason: r.reasonCode,
			status: 'Rejected'
		}));
		submitForm('completeInspectionBatch', {
			rejectedCartridges: JSON.stringify(mapped)
		});
	}

	function handleRecordStorage(cartridgeIds: string[], location: string) {
		submitForm('recordBatchStorage', {
			cartridgeIds: JSON.stringify(cartridgeIds),
			location
		});
	}

	function handleCompleteRun() {
		submitForm('completeRun');
	}

	function sealUrgencyColor(overdue: boolean, minRemaining: number): string {
		if (overdue) return 'text-red-400';
		if (minRemaining <= 15) return 'text-yellow-400';
		return 'text-green-400';
	}
</script>

<div class="mx-auto max-w-5xl space-y-6 p-4">
	<div class="flex items-center gap-3">
		<a href="/manufacturing/opentron-control"
			class="flex items-center justify-center rounded"
			style="min-height: 44px; min-width: 44px; color: var(--color-tron-text-secondary)">
			&#8592;
		</a>
		<div class="flex-1">
			<h1 class="text-xl font-bold text-purple-300">Reagent Post-Processing</h1>
			<p class="text-xs" style="color: var(--color-tron-text-secondary)">
				Run {data.runId.slice(-8)} &middot; {data.robotName} &middot;
				{data.assayTypeName || 'Unknown assay'} &middot;
				{data.cartridgeCount} cartridges
			</p>
		</div>
		<div class="rounded-lg border px-3 py-2 text-center
			{data.sealDeadline.sealOverdue ? 'border-red-500/50 bg-red-900/20' : 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]'}">
			<p class="text-xs" style="color: var(--color-tron-text-secondary)">Seal deadline</p>
			<p class="font-mono text-lg font-bold {sealUrgencyColor(data.sealDeadline.sealOverdue, data.sealDeadline.sealMinRemaining)}">
				{#if data.sealDeadline.sealOverdue}OVERDUE{:else}{data.sealDeadline.sealMinRemaining}m{/if}
			</p>
		</div>
	</div>

	{#if form?.error}
		<div class="rounded-lg border border-red-500/50 bg-red-900/20 p-3 text-sm text-red-300">{form.error}</div>
	{/if}

	<div class="flex items-center gap-2">
		{#each STAGES as stage, i (stage)}
			{@const isCurrent = i === currentStageIndex}
			{@const isPast = i < currentStageIndex}
			<div class="flex items-center gap-2">
				<div class="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold
					{isCurrent ? 'bg-purple-500 text-white' :
					 isPast ? 'bg-green-500/30 text-green-300' :
					 'bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)]'}">
					{#if isPast}&#10003;{:else}{i + 4}{/if}
				</div>
				<span class="text-xs {isCurrent ? 'font-bold text-purple-300' : 'text-[var(--color-tron-text-secondary)]'}">{stage}</span>
			</div>
			{#if i < STAGES.length - 1}
				<div class="h-px flex-1 {isPast ? 'bg-green-500/30' : 'bg-[var(--color-tron-border)]'}"></div>
			{/if}
		{/each}
	</div>

	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-5">
		{#if data.stage === 'Inspection'}
			<Inspection
				cartridges={inspectionCartridges}
				rejectionCodes={data.rejectionCodes}
				onComplete={handleInspectionComplete}
			/>
		{:else if data.stage === 'Top Sealing'}
			<TopSealing
				acceptedCartridges={sealCartridges}
				currentBatch={currentBatch}
				onCreateBatch={(topSealLotId) => submitForm('createTopSealBatch', { topSealLotId })}
				onScanCartridge={(batchId, cartridgeRecordId) => submitForm('scanCartridgeForSeal', { batchId, cartridgeRecordId })}
				onCompleteBatch={(batchId) => submitForm('completeSealBatch', { batchId })}
				onProceedToStorage={() => submitForm('transitionToStorage')}
				onRejectCartridge={(cartridgeId) => submitForm('rejectAtSeal', { cartridgeId })}
			/>
		{:else if data.stage === 'Storage'}
			<CompletionStorage
				cartridges={storageCartridges}
				runSummary={{
					runId: data.runId,
					assayTypeName: data.assayTypeName ?? '',
					cartridgeCount: data.cartridgeCount,
					acceptedCount: data.cartridgesFilled.filter((c: any) => c.inspectionStatus === 'Accepted').length,
					rejectedCount: data.cartridgesFilled.filter((c: any) => c.inspectionStatus === 'Rejected').length,
					qaqcCount: data.cartridgesFilled.filter((c: any) => c.inspectionStatus === 'QA/QC').length
				}}
				fridges={data.fridges}
				onRecordStorage={handleRecordStorage}
				onComplete={handleCompleteRun}
			/>
		{/if}
	</div>
</div>
