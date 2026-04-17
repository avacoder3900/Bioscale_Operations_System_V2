<script lang="ts">
	import { page } from '$app/stores';
	import { goto, invalidateAll } from '$app/navigation';
	import SetupConfirmation from '$lib/components/manufacturing/reagent-filling/SetupConfirmation.svelte';
	import ReagentPreparation from '$lib/components/manufacturing/reagent-filling/ReagentPreparation.svelte';
	import ReagentBatchScan from '$lib/components/manufacturing/reagent-filling/ReagentBatchScan.svelte';
	// ⚠️ MERGE NOTE: Jacob's branch builds the full Reagent Batch system (models, API routes, schema).
	// The ReagentBatchScan component and reagentBatchBarcode param passed to startRun are stubs.
	// When merging Jacob's branch, wire ReagentBatchScan to his API and update startRun to use his batch linkage.
	// DO NOT overwrite Jacob's reagent batch models or routes — this page is the UI consumer only.
	import DeckLoadingGrid from '$lib/components/manufacturing/reagent-filling/DeckLoadingGrid.svelte';
	import RunExecution from '$lib/components/manufacturing/reagent-filling/RunExecution.svelte';
	import Inspection from '$lib/components/manufacturing/reagent-filling/Inspection.svelte';
	// Top Sealing + Storage happen on Opentron Control post-OT-2 queue, not here.

	let { data } = $props();

	let selectedAssayTypeId = $state('');
	let errorMsg = $state('');
	let submitting = $state(false);
	let showCancelModal = $state(false);
	let cancelReason = $state('');
	let showResetModal = $state(false);

	// Admin override state
	let showOverrideModal = $state(false);
	let overrideUser = $state('');
	let overridePass = $state('');
	let overrideError = $state('');
	let pendingOverrideAction = $state('');
	let pendingOverrideData = $state<Record<string, string>>({});

	// Restore error message after hard reload
	$effect(() => {
		const stored = sessionStorage.getItem('reagent-error');
		if (stored) {
			errorMsg = stored;
			sessionStorage.removeItem('reagent-error');
		}
	});

	// Reagent-filling page owns Setup → Load → Run → Inspection (4 stages).
	// Top Sealing (5) and Storage (6) live on Opentron Control's post-OT-2
	// queue, reached by clicking the run card after Inspection completes.
	const STAGES = ['Setup', 'Loading', 'Running', 'Inspection'] as const;
	type Stage = (typeof STAGES)[number];

	// Optimistic stage: prevents UI flash when invalidateAll() returns stale/failed data
	const ACTION_NEXT_STAGE: Record<string, string> = {
		createRun: 'Loading',
		confirmSetup: 'Loading',
		recordReagentPrep: 'Loading',
		loadDeck: 'Loading',
		startRun: 'Running',
		completeRunFilling: 'Inspection',
	};
	let pendingStage = $state<string | null>(null);

	// Reagent batch scan state — tracks whether batch has been scanned and confirmed in the Loading stage
	let reagentBatchConfirmed = $state(false);
	let reagentBatchBarcode = $state<string | null>(null);

	// Preview mode: ?preview shows all stages with clickable picker
	const previewParam = $derived($page.url.searchParams.has('preview'));
	let previewStage = $state<Stage>('Setup');

	const stage = $derived(pendingStage ?? (data.runState.hasActiveRun ? data.runState.stage : null));
	const currentStageIndex = $derived(
		stage ? STAGES.indexOf(stage as Stage) : -1
	);

	// eslint-disable-next-line svelte/prefer-writable-derived -- viewStageIndex is user-writable via arrow buttons
	let viewStageIndex = $state(-1);

	$effect(() => {
		viewStageIndex = currentStageIndex;
	});

	let viewStage = $derived(viewStageIndex >= 0 ? STAGES[viewStageIndex] : null);
	let isViewingPast = $derived(viewStageIndex >= 0 && viewStageIndex < currentStageIndex);
	let isViewingFuture = $derived(viewStageIndex >= 0 && viewStageIndex > currentStageIndex);

	// Skip-ahead override modal
	let showSkipModal = $state(false);
	let skipTargetIndex = $state(-1);

	// In preview mode, override the displayed stage
	const displayStage = $derived(previewParam ? previewStage : viewStage);
	const isPreviewOrPast = $derived(previewParam || isViewingPast);

	function stageLabel(s: string): string {
		switch (s) {
			case 'Setup': return '1. Setup';
			case 'Loading': return '2. Load';
			case 'Running': return '3. Run';
			case 'Inspection': return '4. Inspect';
			default: return s;
		}
	}

	function showError(msg: string) {
		errorMsg = msg;
		// Scroll error into view — it's at the top of the page
		requestAnimationFrame(() => {
			document.querySelector('[data-error-banner]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
		});
	}

	async function submitForm(action: string, extraData: Record<string, string> = {}) {
		if (submitting) return;
		if (previewParam) { showError('Actions disabled in preview mode'); return; }
		submitting = true;
		errorMsg = '';
		pendingOverrideAction = '';
		pendingOverrideData = {};
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 45000);

			const formData = new FormData();
			formData.set('runId', data.activeRunId ?? '');
			formData.set('robotId', data.robotId);
			for (const [key, value] of Object.entries(extraData)) {
				formData.set(key, value);
			}
			const res = await fetch(`?/${action}`, {
				method: 'POST',
				body: formData,
				headers: { 'x-sveltekit-action': 'true' },
				signal: controller.signal
			});
			clearTimeout(timeout);

			// Parse response — SvelteKit uses devalue serialization for action responses
			const text = await res.text();

			// Extract error from SvelteKit action response (handles both failure and HTTP errors)
			if (!res.ok || text.includes('"type":"failure"')) {
				let serverError = `Action failed (HTTP ${res.status})`;
				try {
					const json = JSON.parse(text);
					if (json.type === 'failure' && json.data != null) {
						// SvelteKit devalue format: data is [{"error":1},"actual error message"]
						if (typeof json.data === 'string') {
							const parsed = JSON.parse(json.data);
							if (Array.isArray(parsed)) {
								for (let i = 1; i < parsed.length; i++) {
									if (typeof parsed[i] === 'string' && parsed[i].length > 3) {
										serverError = parsed[i];
										break;
									}
								}
							}
						} else if (Array.isArray(json.data)) {
							for (let i = 1; i < json.data.length; i++) {
								if (typeof json.data[i] === 'string' && json.data[i].length > 3) {
									serverError = json.data[i];
									break;
								}
							}
						} else if (json.data?.error) {
							serverError = json.data.error;
						}
					}
				} catch {
					// Fallback: find readable strings in response
					const strings = text.match(/"([^"\\]{10,})"/g);
					if (strings) {
						const msg = strings[strings.length - 1].slice(1, -1);
						if (msg && !msg.includes('{')) serverError = msg;
					}
				}
				// Store failed loadDeck action for admin override
				if (action === 'loadDeck') {
					pendingOverrideAction = action;
					pendingOverrideData = extraData;
				}
				showError(serverError);
				submitting = false;
				return;
			}

			// Action succeeded — try client-side refresh first (fast on warm functions),
			// fall back to full page reload after 5s (handles cold starts).
			if (action in ACTION_NEXT_STAGE) {
				pendingStage = ACTION_NEXT_STAGE[action];
			}
			const reloadTimer = setTimeout(() => window.location.reload(), 5000);
			await invalidateAll();
			clearTimeout(reloadTimer);
			if (data.runState.hasActiveRun || ['completeRun', 'cancelRun', 'abortRun'].includes(action)) {
				pendingStage = null;
			}
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') {
				showError('Request timed out — the server may be slow. Try again.');
			} else {
				showError(e instanceof Error ? e.message : 'Network error');
			}
		} finally {
			submitting = false;
		}
	}

	// Mock data for preview mode — fields match each component's expected interface
	const mockCartridges = Array.from({ length: 8 }, (_, i) => ({
		// Inspection expects: id, cartridgeId, deckPosition, inspectionStatus, inspectionReason
		id: `CR-${i + 1}`,
		cartridgeId: `CART-${String(i + 1).padStart(4, '0')}`,
		deckPosition: i + 1,
		inspectionStatus: i < 5 ? 'Accepted' : i < 7 ? 'Rejected' : 'QA/QC',
		inspectionReason: i >= 5 && i < 7 ? 'Underfill' : null,
		// CompletionStorage expects: currentStatus, storageLocation
		currentStatus: i < 5 ? 'Sealed' : 'Rejected',
		storageLocation: null as string | null
	}));

	const mockRejectionCodes = [
		{ code: 'UNDERFILL', label: 'Underfill' },
		{ code: 'OVERFILL', label: 'Overfill' },
		{ code: 'CONTAMINATION', label: 'Contamination' },
		{ code: 'DAMAGE', label: 'Physical Damage' }
	];
</script>

<div class="space-y-4">
	{#if previewParam}
		<!-- Preview mode stage picker -->
		<div class="rounded-lg border border-[var(--color-tron-orange)]/50 bg-[var(--color-tron-orange)]/10 p-3">
			<div class="mb-2 flex items-center justify-between">
				<span class="text-xs font-bold text-[var(--color-tron-orange)]">PREVIEW MODE</span>
				<a href="?" class="text-xs text-[var(--color-tron-text-secondary)] underline hover:text-[var(--color-tron-text)]">Exit Preview</a>
			</div>
			<div class="flex flex-wrap gap-2">
				<button type="button" onclick={() => { previewStage = 'Setup'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Setup' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					1. Setup
				</button>
				<button type="button" onclick={() => { previewStage = 'Loading'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Loading' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					2. Reagent Prep
				</button>
				<button type="button" onclick={() => { previewStage = 'Running'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Running' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					3. Running
				</button>
				<button type="button" onclick={() => { previewStage = 'Inspection'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Inspection' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					4. Inspection
				</button>
			</div>
		</div>
	{/if}

	{#if submitting}
		<div class="flex items-center gap-3 rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-3 text-sm text-[var(--color-tron-cyan)]">
			<svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
			</svg>
			Processing...
		</div>
	{/if}

	{#if errorMsg}
		<div data-error-banner class="rounded border border-red-500/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">
			<div class="flex items-center justify-between gap-2">
				<span>{errorMsg}</span>
				<div class="flex shrink-0 items-center gap-2">
					{#if pendingOverrideAction}
						<button
							type="button"
							onclick={() => { showOverrideModal = true; overrideError = ''; }}
							class="rounded border border-amber-500/50 bg-amber-900/20 px-3 py-1 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-900/30"
						>
							Admin Override
						</button>
					{/if}
					<button type="button" onclick={() => { errorMsg = ''; pendingOverrideAction = ''; pendingOverrideData = {}; }} class="text-red-400 hover:text-red-200">&times;</button>
				</div>
			</div>
		</div>
	{/if}

	{#if !previewParam && data.robotBlocked}
		<!-- Robot blocked by other process -->
		<div class="rounded-lg border border-amber-500/50 bg-amber-900/20 p-6 text-center">
			<p class="text-base font-semibold text-amber-300">Robot Busy</p>
			<p class="mt-2 text-sm text-amber-300/80">
				This robot is currently running wax filling{data.robotBlocked.runId ? ` (${data.robotBlocked.runId})` : ''}.
				Complete or cancel the wax run before starting reagent filling.
			</p>
			<a href="/manufacturing/wax-filling?robot={data.robotId}" class="mt-3 inline-block rounded border border-amber-500/50 px-4 py-2 text-sm text-amber-300 hover:bg-amber-900/30">
				Go to Wax Filling
			</a>
		</div>
	{:else if !previewParam && !stage}
		<!-- No active run — show create run UI -->
		<div class="space-y-4">
			<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">New Reagent Filling Run</h2>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Select an assay type and confirm setup to begin.
			</p>
			<div class="flex items-center gap-2">
				<a href="?preview" class="rounded border border-[var(--color-tron-orange)]/50 px-3 py-1.5 text-xs text-[var(--color-tron-orange)] hover:bg-[var(--color-tron-orange)]/10">
					Preview All Stages
				</a>
			</div>
			<SetupConfirmation
				assayTypes={data.assayTypes}
				reagentNames={data.reagentDefinitions}
				{selectedAssayTypeId}
				onSelectAssayType={(id) => { selectedAssayTypeId = id; }}
				onComplete={() => submitForm('createRun', { assayTypeId: selectedAssayTypeId })}
			/>
		</div>

	{:else if !previewParam}
		<!-- Stage progress indicator with navigation arrows -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<div class="mb-2 flex items-center justify-between">
				<span class="text-xs font-medium text-[var(--color-tron-text-secondary)]">
					Run {data.activeRunId}
				</span>
				<div class="flex items-center gap-3">
					<span class="text-xs text-[var(--color-tron-text-secondary)]">
						Stage {currentStageIndex + 1} of {STAGES.length}
					</span>
					<a href="?preview" class="rounded border border-[var(--color-tron-orange)]/40 px-2 py-0.5 text-xs text-[var(--color-tron-orange)] hover:bg-[var(--color-tron-orange)]/10">
						Preview
					</a>
					{#if stage === 'Loading' || stage === 'Running' || stage === 'Inspection'}
						<button
							type="button"
							onclick={() => { showResetModal = true; }}
							class="rounded border border-amber-500/40 px-2 py-0.5 text-xs text-amber-400 transition-colors hover:border-amber-500 hover:bg-amber-900/20 hover:text-amber-300"
						>
							Reset to Deck Loading
						</button>
					{/if}
					<button
						type="button"
						onclick={() => { showCancelModal = true; }}
						class="rounded border border-red-500/40 px-2 py-0.5 text-xs text-red-400 transition-colors hover:border-red-500 hover:bg-red-900/20 hover:text-red-300"
					>
						Cancel Run
					</button>
				</div>
			</div>
			<div class="flex items-center gap-1">
				<button
					type="button"
					disabled={viewStageIndex <= 0}
					onclick={() => { viewStageIndex = Math.max(0, viewStageIndex - 1); }}
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)] disabled:opacity-30 disabled:hover:border-[var(--color-tron-border)] disabled:hover:text-[var(--color-tron-text-secondary)]"
				>
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
					</svg>
				</button>

				{#each STAGES as s, i (s)}
					{@const isCurrent = i === currentStageIndex}
					{@const isPast = i < currentStageIndex}
					{@const isViewing = i === viewStageIndex}
					<div class="flex flex-1 flex-col items-center gap-1">
						<div
							class="flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-colors {isViewing && !isCurrent
								? 'ring-2 ring-[var(--color-tron-yellow)]'
								: ''} {isCurrent
								? 'bg-[var(--color-tron-cyan)] text-white'
								: isPast
									? 'bg-green-600 text-white'
									: 'bg-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}"
						>
							{isPast ? '\u2713' : i + 1}
						</div>
						<span
							class="text-center text-[10px] font-medium {isCurrent
								? 'text-[var(--color-tron-cyan)]'
								: isPast
									? 'text-green-400'
									: 'text-[var(--color-tron-text-secondary)]'}"
						>
							{stageLabel(s)}
						</span>
					</div>
					{#if i < STAGES.length - 1}
						<div
							class="mt-[-16px] h-0.5 flex-1 {isPast
								? 'bg-green-600'
								: 'bg-[var(--color-tron-border)]'}"
						></div>
					{/if}
				{/each}

				<button
					type="button"
					disabled={viewStageIndex >= STAGES.length - 1}
					onclick={() => { viewStageIndex = Math.min(STAGES.length - 1, viewStageIndex + 1); }}
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-30 {viewStageIndex >= currentStageIndex
						? 'border-amber-500/50 text-amber-400 hover:border-amber-500 hover:text-amber-300'
						: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'} disabled:hover:border-[var(--color-tron-border)] disabled:hover:text-[var(--color-tron-text-secondary)]"
				>
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
					</svg>
				</button>
			</div>
		</div>

		{#if isViewingPast}
			<button
				type="button"
				onclick={() => { viewStageIndex = currentStageIndex; }}
				class="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/10 px-4 py-2 text-sm font-medium text-[var(--color-tron-yellow)] transition-colors hover:bg-[var(--color-tron-yellow)]/20"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M13 9l3 3m0 0l-3 3m3-3H8m13 0a9 9 0 11-18 0 9 9 0 0118 0z" />
				</svg>
				Viewing past stage (read-only) — Click to return to current stage
			</button>
		{:else if isViewingFuture}
			<div class="flex w-full items-center justify-between gap-2 rounded-lg border border-amber-500/50 bg-amber-900/20 px-4 py-2">
				<span class="text-sm font-medium text-amber-300">
					Viewing future stage
				</span>
				<div class="flex items-center gap-2">
					<button
						type="button"
						onclick={() => { viewStageIndex = currentStageIndex; }}
						class="min-h-[36px] rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-border)]/30"
					>
						Return
					</button>
					<button
						type="button"
						onclick={() => { skipTargetIndex = viewStageIndex; showSkipModal = true; }}
						disabled={submitting}
						class="min-h-[36px] rounded border border-amber-500/50 bg-amber-900/30 px-3 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-900/40 disabled:opacity-50"
					>
						Skip to {stageLabel(STAGES[viewStageIndex])}
					</button>
				</div>
			</div>
		{/if}
	{/if}

	<!-- Stage content: works for both normal mode and preview mode -->
	{#if displayStage === 'Setup'}
		<SetupConfirmation
			assayTypes={data.assayTypes}
			reagentNames={data.reagentDefinitions}
			selectedAssayTypeId={previewParam ? 'preview' : (data.runState.assayTypeName ?? 'selected')}
			onSelectAssayType={previewParam ? () => {} : (id) => { selectedAssayTypeId = id; }}
			onComplete={() => submitForm(stage ? 'confirmSetup' : 'createRun', stage ? {} : { assayTypeId: selectedAssayTypeId })}
			readonly={isViewingPast}
		/>

	{:else if displayStage === 'Loading' && (previewParam || data.cartridges.length === 0)}
		<!-- Step 1: Deck Loading first -->
		<DeckLoadingGrid
			onComplete={({ deckId, cartridgeScans }) =>
				submitForm('loadDeck', { deckId, cartridgeScans: JSON.stringify(cartridgeScans) })}
			readonly={isViewingPast}
			focusPaused={showCancelModal}
		/>

	{:else if displayStage === 'Loading' && data.cartridges.length > 0 && !reagentBatchConfirmed}
		<!-- Step 2: Deck loaded — now scan reagent batch barcode -->
		<ReagentPreparation
			reagentDefinitions={data.reagentDefinitions}
			cartridgeCount={data.cartridges.length}
			onComplete={(tubes) => {
				reagentBatchBarcode = tubes[0]?.sourceLotId ?? '';
				reagentBatchConfirmed = true;
				submitForm('recordReagentPrep', { tubes: JSON.stringify(tubes) });
			}}
			readonly={isViewingPast}
		/>

	{:else if displayStage === 'Loading' && data.cartridges.length > 0 && reagentBatchConfirmed}
		<!-- Step 3: Deck loaded AND batch confirmed — show summary and Start Run -->
		<div class="space-y-4">
			<div class="rounded-lg border border-green-500/30 bg-green-900/10 p-4">
				<div class="flex items-center gap-3">
					<svg class="h-6 w-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
					</svg>
					<div>
						<p class="font-semibold text-green-400">Deck Loaded &amp; Reagent Batch Verified</p>
						<p class="text-sm text-green-300/70">{data.cartridges.length} cartridges ready · Batch {reagentBatchBarcode}</p>
					</div>
				</div>
			</div>
			{#if !isViewingPast}
				<button type="button"
					onclick={() => submitForm('startRun', { reagentBatchBarcode: reagentBatchBarcode ?? '' })}
					disabled={submitting}
					class="min-h-[52px] w-full rounded-lg border border-green-500/50 bg-green-900/20 px-6 py-4 text-lg font-bold text-green-400 transition-all hover:bg-green-900/30 disabled:opacity-50"
				>
					{submitting ? 'Starting Run...' : `Start Run (${data.cartridges.length} cartridges)`}
				</button>
			{/if}
		</div>

	{:else if displayStage === 'Running'}
		<RunExecution
			assayTypeName={previewParam ? 'Preview Assay' : (data.runState.assayTypeName ?? 'Unknown')}
			cartridgeCount={previewParam ? 8 : (data.runState.cartridgeCount ?? 0)}
			runStartTime={new Date(data.runState.runStartTime ?? Date.now())}
			runEndTime={new Date(data.runState.runEndTime ?? (Date.now() + 600000))}
			onTimerComplete={() => submitForm('completeRunFilling')}
			onAbort={(reason, photoUrl) => submitForm('abortRun', { reason, photoUrl: photoUrl ?? '' })}
			readonly={isViewingPast}
		/>

	{:else if displayStage === 'Inspection'}
		<Inspection
			cartridges={previewParam ? mockCartridges : data.cartridges}
			rejectionCodes={previewParam ? mockRejectionCodes : data.rejectionCodes}
			onComplete={async ({ rejectedCartridges }) => {
				if (previewParam) { errorMsg = 'Actions disabled in preview mode'; return; }
				await submitForm('completeInspectionBatch', { rejectedCartridges: JSON.stringify(rejectedCartridges) });
				// Final step on this page — hand off to Opentron Control so the
				// operator can start another run. Top Sealing + Storage for this
				// run are picked up from the post-OT-2 queue there.
				if (!errorMsg) await goto('/manufacturing/opentron-control');
			}}
			readonly={isViewingPast}
			focusPaused={showCancelModal || showResetModal || showOverrideModal}
		/>
	{/if}

	<!-- Cancel Run Modal -->
	{#if showCancelModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div class="mx-4 w-full max-w-md rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 shadow-xl">
				<h3 class="text-lg font-semibold text-[var(--color-tron-text)]">Cancel Run</h3>
				<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
					Are you sure you want to cancel run {data.activeRunId}? This action cannot be undone.
				</p>
				<label class="mt-4 block">
					<span class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Reason</span>
					<textarea
						bind:value={cancelReason}
						rows="3"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
						placeholder="Enter reason for cancellation..."
					></textarea>
				</label>
				<div class="mt-4 flex justify-end gap-3">
					<button
						type="button"
						onclick={() => { showCancelModal = false; cancelReason = ''; }}
						class="rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-border)]/30"
					>
						Go Back
					</button>
					<button
						type="button"
						onclick={() => { showCancelModal = false; submitForm('cancelRun', { reason: cancelReason.trim() }); cancelReason = ''; }}
						disabled={!cancelReason.trim() || submitting}
						class="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
					>
						{submitting ? 'Cancelling...' : 'Confirm Cancel'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Reset to Deck Loading Modal -->
	{#if showResetModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div class="mx-4 w-full max-w-md rounded-lg border border-amber-500/30 bg-[var(--color-tron-surface)] p-6 shadow-xl">
				<h3 class="text-lg font-semibold text-amber-300">Reset to Deck Loading</h3>
				<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
					This will delete all cartridge records and seal batches for this run, release the deck,
					and return to the deck loading step. Reagent tube entries will be preserved.
				</p>
				<p class="mt-2 text-sm font-medium text-amber-300/80">
					This cannot be undone. Are you sure?
				</p>
				<div class="mt-4 flex justify-end gap-3">
					<button
						type="button"
						onclick={() => { showResetModal = false; }}
						class="rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-border)]/30"
					>
						Go Back
					</button>
					<button
						type="button"
						onclick={() => { showResetModal = false; submitForm('resetToLoading'); }}
						disabled={submitting}
						class="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
					>
						{submitting ? 'Resetting...' : 'Confirm Reset'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Admin Override Modal -->
	{#if showOverrideModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div class="mx-4 w-full max-w-md rounded-lg border border-amber-500/30 bg-[var(--color-tron-surface)] p-6 shadow-xl">
				<h3 class="text-lg font-semibold text-amber-300">Admin Override</h3>
				<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
					Enter admin credentials to bypass validation and force this action through.
				</p>
				{#if overrideError}
					<div class="mt-3 rounded border border-red-500/30 bg-red-900/20 px-3 py-2 text-xs text-red-300">
						{overrideError}
					</div>
				{/if}
				<label class="mt-4 block">
					<span class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Username</span>
					<input
						type="text"
						bind:value={overrideUser}
						autocomplete="username"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)] focus:border-amber-500 focus:outline-none"
						placeholder="Admin username"
					/>
				</label>
				<label class="mt-3 block">
					<span class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Password</span>
					<input
						type="password"
						bind:value={overridePass}
						autocomplete="current-password"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)] focus:border-amber-500 focus:outline-none"
						placeholder="Admin password"
					/>
				</label>
				<div class="mt-4 flex justify-end gap-3">
					<button
						type="button"
						onclick={() => { showOverrideModal = false; overrideUser = ''; overridePass = ''; overrideError = ''; }}
						class="rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-border)]/30"
					>
						Cancel
					</button>
					<button
						type="button"
						disabled={!overrideUser.trim() || !overridePass || submitting}
						onclick={() => {
							showOverrideModal = false;
							errorMsg = '';
							submitForm(pendingOverrideAction, {
								...pendingOverrideData,
								adminUser: overrideUser.trim(),
								adminPass: overridePass
							});
							overrideUser = '';
							overridePass = '';
							overrideError = '';
							pendingOverrideAction = '';
							pendingOverrideData = {};
						}}
						class="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
					>
						{submitting ? 'Verifying...' : 'Override'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Skip Stage Confirmation Modal -->
	{#if showSkipModal && skipTargetIndex >= 0}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div class="mx-4 w-full max-w-md rounded-lg border border-amber-500/30 bg-[var(--color-tron-surface)] p-6 shadow-xl">
				<h3 class="text-lg font-semibold text-amber-300">Skip to {stageLabel(STAGES[skipTargetIndex])}</h3>
				<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
					This will advance the run directly from
					<span class="font-medium text-[var(--color-tron-cyan)]">{stageLabel(STAGES[currentStageIndex])}</span>
					to
					<span class="font-medium text-amber-300">{stageLabel(STAGES[skipTargetIndex])}</span>,
					skipping intermediate steps.
				</p>
				<p class="mt-2 text-sm font-medium text-amber-300/80">
					This action is logged and may affect data integrity. Continue?
				</p>
				<div class="mt-4 flex justify-end gap-3">
					<button
						type="button"
						onclick={() => { showSkipModal = false; skipTargetIndex = -1; }}
						class="rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-border)]/30"
					>
						Go Back
					</button>
					<button
						type="button"
						disabled={submitting}
						onclick={() => {
							showSkipModal = false;
							const target = STAGES[skipTargetIndex];
							skipTargetIndex = -1;
							submitForm('forceAdvanceStage', { targetStage: target });
						}}
						class="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
					>
						{submitting ? 'Advancing...' : 'Confirm Skip'}
					</button>
				</div>
			</div>
		</div>
	{/if}
</div>
