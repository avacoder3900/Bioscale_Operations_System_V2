<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import SetupConfirmation from '$lib/components/manufacturing/wax-filling/SetupConfirmation.svelte';
	import WaxPreparation from '$lib/components/manufacturing/wax-filling/WaxPreparation.svelte';
	import DeckLoadingGrid from '$lib/components/manufacturing/wax-filling/DeckLoadingGrid.svelte';
	import RunExecution from '$lib/components/manufacturing/wax-filling/RunExecution.svelte';
	import PostRunCooling from '$lib/components/manufacturing/wax-filling/PostRunCooling.svelte';
	import QCInspection from '$lib/components/manufacturing/wax-filling/QCInspection.svelte';
	import CompletionStorage from '$lib/components/manufacturing/wax-filling/CompletionStorage.svelte';
	import type { RejectionReasonCode } from '$lib/server/db/schema';

	interface Props {
		data: {
			robotId: string;
			loadError: string | null;
			robotBlocked: { process: 'reagent'; runId: string | null } | null;
			runState: {
				hasActiveRun: boolean;
				runId: string | null;
				stage: string | null;
				runStartTime: string | null;
				runEndTime: string | null;
				deckRemovedTime: string | null;
				deckId: string | null;
				waxSourceLot: string | null;
				coolingTrayId: string | null;
				plannedCartridgeCount: number | null;
				coolingConfirmedAt: string | null;
				coolingConfirmedAt: string | null;
			};
			settings: {
				runDurationMin: number;
				removeDeckWarningMin: number;
				coolingWarningMin: number;
				deckLockoutMin: number;
				incubatorTempC: number;
				heaterTempC: number;
			};
			tubeData: {
				tubeId: string;
				initialVolumeUl: number;
				remainingVolumeUl: number;
				status: string;
				totalCartridgesFilled: number;
				totalRunsUsed: number;
			} | null;
			activeLotId: string | null;
			activeLotCartridgeCount: number | null;
			ovenLots: {
				lotId: string;
				ready: boolean;
				cartridgeCount: number;
				ovenName?: string;
				ovenId?: string;
				elapsedMin?: number;
				remainingMin?: number;
				ovenEntryTime?: string | null;
			}[];
			minOvenTimeMin: number;
			rejectionCodes: RejectionReasonCode[];
			qcCartridges: {
				cartridgeId: string;
				backedLotId: string;
				ovenEntryTime: string | null;
				waxRunId: string | null;
				deckPosition: number | null;
				waxTubeId: string | null;
				coolingTrayId: string | null;
				transferTimeSeconds: number | null;
				qcStatus: string;
				rejectionReason: string | null;
				qcTimestamp: string | null;
				currentInventory: string;
				storageLocation: string | null;
				storageTimestamp: string | null;
				storageOperatorId: string | null;
				createdAt: string;
				updatedAt: string;
			}[];
			storageCartridges: {
				cartridgeId: string;
				qcStatus: string;
				currentInventory: string;
				storageLocation: string | null;
			}[];
			fridges: {
				id: string;
				displayName: string;
				barcode: string;
			}[];
		};
	}

	let { data }: Props = $props();

	let submitting = $state(false);
	let submittingTooLong = $state(false);
	let errorMsg = $state('');
	let coolingBypassed = $state(false);
	let showCoolingBypass = $state(false);
	let coolingBypassPassword = $state('');
	let coolingBypassError = $state('');

	function handleCoolingBypass() {
		// Check admin password via server validation
		const pw = coolingBypassPassword.trim();
		if (!pw) { coolingBypassError = 'Enter admin password'; return; }
		fetch('/api/dev/validate-equipment?type=admin-password&id=' + encodeURIComponent(pw))
			.then(r => r.json())
			.then(d => {
				if (d.valid) {
					coolingBypassed = true;
					showCoolingBypass = false;
					coolingBypassError = '';
					coolingBypassPassword = '';
				} else {
					coolingBypassError = 'Invalid admin password';
				}
			})
			.catch(() => { coolingBypassError = 'Verification failed'; });
	}
	let showCancelModal = $state(false);
	let cancelReason = $state('');

	// Backing lot scan state
	let lotScanInput = $state('');
	let lotScanError = $state('');
	let lotScanSuccess = $state(false);
	let lotScanSubmitting = $state(false);
	let lotOverride = $state(false);
	// confirmed lot — once scanned OK, set from server response or existing activeLotId
	let confirmedLotId = $state<string | null>(data.activeLotId ?? null);
	let confirmedLotCount = $state<number | null>(data.activeLotCartridgeCount ?? null);

	// Keep confirmedLotId in sync if server already has one (e.g. after page reload)
	$effect(() => {
		if (data.activeLotId && !confirmedLotId) {
			confirmedLotId = data.activeLotId;
			confirmedLotCount = data.activeLotCartridgeCount ?? null;
			lotScanSuccess = true;
		}
	});

	async function handleScanBackingLot() {
		if (!lotScanInput.trim() || !data.runState.runId) return;
		lotScanSubmitting = true;
		lotScanError = '';
		lotScanSuccess = false;
		try {
			const fd = new FormData();
			fd.set('lotBarcode', lotScanInput.trim());
			fd.set('runId', data.runState.runId);
			if (lotOverride) fd.set('override', 'true');
			const res = await fetch('?/scanBackingLot', {
				method: 'POST',
				body: fd,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const json = await res.json();
			if (!res.ok) {
				const msg = json?.error ?? json?.data?.error ?? `Error ${res.status}`;
				lotScanError = msg;
				// If the server says the bucket is short of its oven time,
				// stage an admin override: open the modal pre-loaded with
				// this lot. On confirm, the modal resubmits scanBackingLot
				// with adminUser/adminPass + override=true.
				const payload = json?.data ?? json;
				if (payload?.requiresOverride && payload?.lotId) {
					pendingOverrideAction = 'scanBackingLot';
					pendingOverrideData = {
						lotBarcode: payload.lotId,
						runId: data.runState.runId ?? '',
						override: 'true'
					};
				}
			} else {
				const d = json?.data ?? json;
				confirmedLotId = d?.lotId ?? lotScanInput.trim();
				confirmedLotCount = d?.cartridgeCount ?? null;
				lotScanSuccess = true;
				lotScanInput = '';
				await invalidateAll();
			}
		} catch (e) {
			lotScanError = e instanceof Error ? e.message : 'Scan failed';
		} finally {
			lotScanSubmitting = false;
		}
	}

	function handleLotScanKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && lotScanInput.trim()) {
			e.preventDefault();
			handleScanBackingLot();
		}
	}

	// Admin override state
	let showOverrideModal = $state(false);
	let overrideUser = $state('');
	let overridePass = $state('');
	let overrideError = $state('');
	let pendingOverrideAction = $state('');
	let pendingOverrideData = $state<Record<string, string>>({});

	const STAGES = ['Setup', 'Loading', 'Running', 'Awaiting Removal', 'QC', 'Storage'] as const;

	// Optimistic stage: prevents UI flash when invalidateAll() returns stale/failed data
	const ACTION_NEXT_STAGE: Record<string, string> = {
		confirmSetup: 'Loading',
		recordWaxPrep: 'Loading',
		loadDeck: 'Loading',
		startRun: 'Running',
		confirmDeckRemoved: 'Awaiting Removal',
		confirmCooling: 'QC',
		completeQC: 'Storage',
	};
	let pendingStage = $state<string | null>(null);
	let effectiveStage = $derived(pendingStage ?? (data.runState.hasActiveRun ? data.runState.stage : null));
	let effectiveHasActiveRun = $derived(!!pendingStage || data.runState.hasActiveRun);

	let currentStageIndex = $derived(
		effectiveHasActiveRun && effectiveStage
			? STAGES.indexOf(effectiveStage as (typeof STAGES)[number])
			: -1
	);

	// eslint-disable-next-line svelte/prefer-writable-derived -- viewStageIndex is user-writable via arrow buttons
	let viewStageIndex = $state(-1);

	// Reset viewStageIndex when currentStageIndex changes
	$effect(() => {
		viewStageIndex = currentStageIndex;
	});

	let viewStage = $derived(viewStageIndex >= 0 ? STAGES[viewStageIndex] : null);
	let isViewingPast = $derived(viewStageIndex >= 0 && viewStageIndex < currentStageIndex);

	function stageLabel(stage: string): string {
		switch (stage) {
			case 'Setup':
				return '1. Setup';
			case 'Loading':
				return '2. Load';
			case 'Running':
				return '3. Run';
			case 'Awaiting Removal':
				return '4. Cool';
			case 'QC':
				return '5. QC';
			case 'Storage':
				return '6. Store';
			default:
				return stage;
		}
	}

	// Restore error message after hard reload
	$effect(() => {
		const stored = sessionStorage.getItem('wax-error');
		if (stored) {
			errorMsg = stored;
			sessionStorage.removeItem('wax-error');
		}
	});

	async function forceReload() {
		await invalidateAll();
		submitting = false;
		submittingTooLong = false;
	}

	async function submitAction(action: string, formData: Record<string, string>) {
		if (submitting) return;
		submitting = true;
		submittingTooLong = false;
		errorMsg = '';
		pendingOverrideAction = '';
		pendingOverrideData = {};

		// Show escape button after 5 seconds
		const slowTimer = setTimeout(() => { submittingTooLong = true; }, 5000);

		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 45000);

			const fd = new FormData();
			for (const [k, v] of Object.entries(formData)) {
				fd.set(k, v);
			}
			const res = await fetch(`?/${action}`, {
				method: 'POST',
				body: fd,
				headers: { 'x-sveltekit-action': 'true' },
				signal: controller.signal
			});
			clearTimeout(timeout);
			clearTimeout(slowTimer);
			if (!res.ok) {
				let serverError = `Action failed (HTTP ${res.status})`;
				try {
					const text = await res.text();
					const match = text.match(/error[^"]*"([^"]+)"/);
					if (match?.[1]) serverError = match[1];
				} catch { /* ignore parse error */ }
				// Store failed loadDeck action for admin override
				if (action === 'loadDeck') {
					pendingOverrideAction = action;
					pendingOverrideData = formData;
				}
				errorMsg = serverError;
				await invalidateAll();
				return;
			}
			// Optimistic stage update — show the expected next stage immediately
			if (action in ACTION_NEXT_STAGE) {
				pendingStage = ACTION_NEXT_STAGE[action];
			}
			// Re-run all load functions to refresh data
			await invalidateAll();
			// Clear pending stage if server returned valid data, or if this was a terminal action
			if (data.runState.hasActiveRun || ['completeRun', 'cancelRun', 'abortRun'].includes(action)) {
				pendingStage = null;
			}
		} catch (e) {
			clearTimeout(slowTimer);
			if (e instanceof DOMException && e.name === 'AbortError') {
				errorMsg = 'Request timed out — the server may be slow.';
			} else {
				errorMsg = e instanceof Error ? e.message : 'Request failed';
			}
		} finally {
			submitting = false;
			submittingTooLong = false;
		}
	}

	function handleSetupComplete() {
		if (previewParam) return;
		if (data.runState.runId) {
			submitAction('confirmSetup', { runId: data.runState.runId });
		}
	}

	function handleWaxPrepComplete(result: { sourceLot: string; tubeId: string; plannedCartridgeCount?: number }) {
		if (previewParam) return;
		if (data.runState.runId) {
			submitAction('recordWaxPrep', {
				runId: data.runState.runId,
				waxSourceLot: result.sourceLot,
				waxTubeId: result.tubeId,
				plannedCartridgeCount: String(result.plannedCartridgeCount ?? 24)
			});
		}
	}

	function handleDeckLoadComplete(result: {
		deckId: string;
		ovenId: string;
		cartridgeScans: { cartridgeId: string; backedLotId: string }[];
		countMismatchReason?: string;
	}) {
		if (previewParam) return;
		if (data.runState.runId) {
			const formData: Record<string, string> = {
				runId: data.runState.runId,
				deckId: result.deckId,
				ovenId: result.ovenId,
				cartridgeScans: JSON.stringify(result.cartridgeScans)
			};
			if (result.countMismatchReason) {
				formData.countMismatchReason = result.countMismatchReason;
			}
			submitAction('loadDeck', formData);
		}
	}

	function handleRunStarted() {
		if (data.runState.runId) {
			submitAction('startRun', { runId: data.runState.runId });
		}
	}

	function handleDeckRemoved() {
		if (data.runState.runId) {
			submitAction('confirmDeckRemoved', { runId: data.runState.runId });
		}
	}

	function handleResetToLoading() {
		if (data.runState.runId) {
			submitAction('resetToLoading', { runId: data.runState.runId });
		}
	}

	function handleAborted(result: {
		usableCartridgeIds: string[];
		scrapCartridgeIds: string[];
		scrapReason: string;
		columnsCompleted: number;
	}) {
		if (data.runState.runId) {
			submitAction('abortRun', {
				runId: data.runState.runId,
				usableCartridgeIds: JSON.stringify(result.usableCartridgeIds),
				scrapCartridgeIds: JSON.stringify(result.scrapCartridgeIds),
				scrapReason: result.scrapReason,
				columnsCompleted: String(result.columnsCompleted)
			});
		}
	}

	async function handleCancelRun() {
		if (!data.runState.runId || !cancelReason.trim()) return;
		showCancelModal = false;
		await submitAction('cancelRun', {
			runId: data.runState.runId,
			reason: cancelReason.trim()
		});
		cancelReason = '';
	}

	function handleCoolingComplete(result: { trayId: string; coolingTimestamp: Date }) {
		if (data.runState.runId) {
			submitAction('confirmCooling', {
				runId: data.runState.runId,
				coolingTrayId: result.trayId
			});
		}
	}

	function handleQCComplete(result: {
		rejectedCartridges: { cartridgeId: string; reasonCode: string }[];
	}) {
		handleQCSequential(result.rejectedCartridges);
	}

	async function handleQCSequential(
		rejectedCartridges: { cartridgeId: string; reasonCode: string }[]
	) {
		if (submitting) return;
		submitting = true;
		submittingTooLong = false;
		const slowTimer = setTimeout(() => { submittingTooLong = true; }, 5000);
		try {
			// Reject each cartridge individually
			for (const c of rejectedCartridges) {
				const fd = new FormData();
				fd.set('cartridgeId', c.cartridgeId);
				fd.set('reasonCode', c.reasonCode);
				const res = await fetch('?/rejectCartridge', {
					method: 'POST',
					body: fd,
					headers: { 'x-sveltekit-action': 'true' }
				});
				if (!res.ok) {
					errorMsg = 'Failed to reject cartridge';
					break;
				}
			}
			// Then complete QC for the tray
			if (!errorMsg) {
				const trayId = data.runState.coolingTrayId ?? data.qcCartridges[0]?.coolingTrayId;
				if (trayId) {
					const fd = new FormData();
					fd.set('trayId', trayId);
					if (data.runState.runId) fd.set('runId', data.runState.runId);
					const res = await fetch('?/completeQC', {
						method: 'POST',
						body: fd,
						headers: { 'x-sveltekit-action': 'true' }
					});
					if (!res.ok) {
						errorMsg = 'Failed to complete QC';
					}
				}
			}
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : 'QC failed';
		}
		clearTimeout(slowTimer);
		pendingStage = 'Storage';
		await invalidateAll();
		if (data.runState.hasActiveRun) {
			pendingStage = null;
		}
		submitting = false;
		submittingTooLong = false;
	}

	function handleRecordStorage(cartridgeIds: string[], location: string) {
		console.log('[handleRecordStorage] cartridgeIds:', cartridgeIds, 'location:', JSON.stringify(location));
		if (previewParam) return;
		submitAction('recordBatchStorage', {
			cartridgeIds: JSON.stringify(cartridgeIds),
			storageLocation: location
		});
	}

	function handleCompleteRun() {
		if (previewParam) return;
		if (data.runState.runId) {
			submitAction('completeRun', { runId: data.runState.runId });
		}
	}

	// Cooling timer: block QC for 10 minutes after coolingConfirmedAt
	const COOLING_REQUIRED_MS = 10 * 60 * 1000;
	let coolingTick = $state(0);
	$effect(() => {
		if (data.runState.stage === 'QC' && data.runState.coolingConfirmedAt && !coolingBypassed) {
			const interval = setInterval(() => { coolingTick++; }, 1000);
			return () => clearInterval(interval);
		}
	});
	const coolingConfirmedAt = $derived(data.runState.coolingConfirmedAt ? new Date(data.runState.coolingConfirmedAt) : null);
	const coolingElapsedMs = $derived.by(() => {
		void coolingTick;
		if (coolingBypassed) return COOLING_REQUIRED_MS;
		return coolingConfirmedAt ? Date.now() - coolingConfirmedAt.getTime() : COOLING_REQUIRED_MS;
	});
	const coolingRemainingMs = $derived(Math.max(0, COOLING_REQUIRED_MS - coolingElapsedMs));
	const coolingComplete = $derived(coolingRemainingMs === 0 || coolingBypassed);
	const coolingCountdown = $derived.by(() => {
		const totalSec = Math.ceil(coolingRemainingMs / 1000);
		const m = Math.floor(totalSec / 60);
		const s = totalSec % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
	});

	// Loading stage has 3 sub-steps: wax prep -> deck loading -> ready to run
	let loadingSubStage = $derived.by(() => {
		if (!effectiveHasActiveRun || (viewStage !== 'Loading' && effectiveStage !== 'Loading')) return 'wax_prep';
		if (data.runState.deckId) return 'ready_to_run';
		if (data.runState.waxSourceLot) return 'deck_load';
		return 'wax_prep';
	});

	// Lot scan is required before deck loading sub-stage
	let lotConfirmed = $derived(!!confirmedLotId || !!data.activeLotId);

	// Preview mode
	type WaxStage = (typeof STAGES)[number];
	const previewParam = $derived($page.url.searchParams.has('preview'));
	let previewStage = $state<WaxStage>('Setup');
	let previewLoadingSub = $state<'wax_prep' | 'deck_load' | 'ready_to_run'>('wax_prep');
	const displayStage = $derived(previewParam ? previewStage : viewStage);
	const displayLoadingSub = $derived(previewParam ? previewLoadingSub : loadingSubStage);
	const isPreviewOrPast = $derived(previewParam || isViewingPast);

	const mockQcCartridges = Array.from({ length: 6 }, (_, i) => ({
		cartridgeId: `CART-${String(i + 1).padStart(4, '0')}`,
		backedLotId: `LOT-001`,
		ovenEntryTime: new Date(Date.now() - 3600000) as Date | null,
		waxRunId: 'WXR-PREVIEW',
		deckPosition: i + 1 as number | null,
		waxTubeId: 'TUBE-001' as string | null,
		coolingTrayId: 'TRAY-001' as string | null,
		transferTimeSeconds: 45 as number | null,
		qcStatus: 'Pending',
		rejectionReason: null as string | null,
		qcTimestamp: null as Date | null,
		currentInventory: 'WaxFilling',
		storageLocation: null as string | null,
		storageTimestamp: null as Date | null,
		storageOperatorId: null as string | null,
		createdAt: new Date(),
		updatedAt: new Date()
	}));

	const mockStorageCartridges = [
		...Array.from({ length: 5 }, (_, i) => ({
			cartridgeId: `CART-${String(i + 1).padStart(4, '0')}`,
			qcStatus: 'Accepted',
			currentInventory: 'Cooled Cartridge',
			storageLocation: null as string | null
		})),
		{
			cartridgeId: 'CART-0006',
			qcStatus: 'Rejected',
			currentInventory: 'Rejected',
			storageLocation: null as string | null
		}
	];
</script>

<div class="space-y-6">
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
				<button type="button" onclick={() => { previewStage = 'Loading'; previewLoadingSub = 'wax_prep'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Loading' && previewLoadingSub === 'wax_prep' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					2a. Wax Prep
				</button>
				<button type="button" onclick={() => { previewStage = 'Loading'; previewLoadingSub = 'deck_load'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Loading' && previewLoadingSub === 'deck_load' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					2b. Deck Load
				</button>
				<button type="button" onclick={() => { previewStage = 'Loading'; previewLoadingSub = 'ready_to_run'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Loading' && previewLoadingSub === 'ready_to_run' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					2c. Ready
				</button>
				<button type="button" onclick={() => { previewStage = 'Running'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Running' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					3. Running
				</button>
				<button type="button" onclick={() => { previewStage = 'Awaiting Removal'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Awaiting Removal' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					4. Cool
				</button>
				<button type="button" onclick={() => { previewStage = 'QC'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'QC' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					5. QC
				</button>
				<button type="button" onclick={() => { previewStage = 'Storage'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Storage' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					6. Store
				</button>
			</div>
		</div>
	{/if}

	{#if data.loadError}
		<div class="rounded-lg border border-amber-500/50 bg-amber-900/20 px-4 py-3 text-sm text-amber-300">
			<p class="font-medium">Connection issue — data may be stale</p>
			<p class="mt-1 text-xs text-amber-400/70">{data.loadError}</p>
			<button type="button" onclick={() => window.location.reload()}
				class="mt-2 rounded border border-amber-500/50 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-900/30">
				Retry
			</button>
		</div>
	{/if}

	{#if errorMsg}
		<div class="rounded border border-red-500/30 bg-red-900/30 px-4 py-3 text-sm text-red-300">
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
					<button
						type="button"
						class="text-red-400 underline"
						onclick={() => { errorMsg = ''; pendingOverrideAction = ''; pendingOverrideData = {}; }}
					>
						Dismiss
					</button>
				</div>
			</div>
		</div>
	{/if}

	{#if !previewParam && !effectiveHasActiveRun && data.robotBlocked}
		<!-- Robot blocked by other process -->
		<div class="space-y-6 py-8">
			<div class="rounded-lg border border-amber-500/50 bg-amber-900/20 p-6 text-center">
				<p class="text-base font-semibold text-amber-300">Robot Busy</p>
				<p class="mt-2 text-sm text-amber-300/80">
					This robot is currently running reagent filling{data.robotBlocked.runId ? ` (${data.robotBlocked.runId})` : ''}.
					Complete or cancel the reagent run before starting wax filling.
				</p>
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a href="/manufacturing/reagent-filling?robot={data.robotId}" class="mt-3 inline-block rounded border border-amber-500/50 px-4 py-2 text-sm text-amber-300 hover:bg-amber-900/30">
					Go to Reagent Filling
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			</div>
		</div>
	{:else if !previewParam && !effectiveHasActiveRun}
		<!-- No active run: initiate wax filling directly -->
		<div class="space-y-6 py-8">
			<div class="text-center">
				<div class="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full border-2 border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
					<svg class="h-10 w-10 text-[var(--color-tron-cyan)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
					</svg>
				</div>
				<h2 class="text-xl font-semibold text-[var(--color-tron-text)]">
					{data.robotId === 'robot-1' ? 'Robot 1' : 'Robot 2'} — Wax Filling
				</h2>
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
					Start a new wax filling run on this robot.
				</p>
			</div>

			<div class="mx-auto max-w-md">
				<form
					method="POST"
					action="?/createRun"
					use:enhance={() => {
						submitting = true;
						return async ({ result }) => {
							if (result.type === 'failure') {
								errorMsg = (result.data as Record<string, string>)?.error ?? 'Failed to create run';
							} else {
								pendingStage = 'Setup';
							}
							await invalidateAll();
							if (data.runState.hasActiveRun) {
								pendingStage = null;
							}
							submitting = false;
						};
					}}
				>
					<input type="hidden" name="robotId" value={data.robotId} />
					<button
						type="submit"
						disabled={submitting}
						class="min-h-[44px] w-full rounded-lg bg-[var(--color-tron-cyan)] px-8 py-3 text-base font-semibold text-white transition-colors hover:bg-[var(--color-tron-cyan)]/80 disabled:opacity-50"
					>
						{submitting ? 'Creating...' : 'Start Wax Filling Run'}
					</button>
				</form>
			</div>

			<div class="text-center">
				<a href="?preview" class="rounded border border-[var(--color-tron-orange)]/50 px-4 py-2 text-sm text-[var(--color-tron-orange)] hover:bg-[var(--color-tron-orange)]/10">
					Preview All Stages
				</a>
			</div>
		</div>
	{:else if !previewParam}
		<!-- Active run: show stage wizard -->
		<div class="space-y-6">
			<!-- Stage progress indicator with navigation arrows -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<div class="mb-2 flex items-center justify-between">
					<span class="text-xs font-medium text-[var(--color-tron-text-secondary)]">
						Run {data.runState.runId}
					</span>
					<div class="flex items-center gap-3">
					<a href="/manufacturing/reagent-filling?robot={data.robotId}" class="rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20">Move to Reagent Run →</a>
					<span class="text-xs text-[var(--color-tron-text-secondary)]">
						Stage {currentStageIndex + 1} of {STAGES.length}
					</span>
					<a href="?preview" class="rounded border border-[var(--color-tron-orange)]/40 px-2 py-0.5 text-xs text-[var(--color-tron-orange)] hover:bg-[var(--color-tron-orange)]/10">Preview</a>
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
					<!-- Left arrow -->
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

					{#each STAGES as stage, i (stage)}
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
								{stageLabel(stage)}
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

					<!-- Right arrow -->
					<button
						type="button"
						disabled={viewStageIndex >= currentStageIndex}
						onclick={() => { viewStageIndex = Math.min(currentStageIndex, viewStageIndex + 1); }}
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)] disabled:opacity-30 disabled:hover:border-[var(--color-tron-border)] disabled:hover:text-[var(--color-tron-text-secondary)]"
					>
						<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
						</svg>
					</button>
				</div>
			</div>

			<!-- Back to Current Stage banner -->
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
			{/if}

			<!-- Incubator Tube Info (visible during Loading through QC) -->
			{#if data.tubeData && data.runState.stage && ['Loading', 'Running', 'Awaiting Removal', 'Cooling', 'QC', 'Storage'].includes(data.runState.stage)}
				{@const pct = data.tubeData.initialVolumeUl > 0 ? (data.tubeData.remainingVolumeUl / data.tubeData.initialVolumeUl) * 100 : 0}
				{@const barColor = pct > 50 ? 'bg-green-500' : pct > 25 ? 'bg-amber-500' : 'bg-red-500'}
				{@const maxCartridges = Math.floor(data.tubeData.remainingVolumeUl / 50)}
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
					<div class="mb-2 flex items-center justify-between">
						<h3 class="text-sm font-semibold text-[var(--color-tron-cyan)]">Incubator Tube</h3>
						<span class="font-mono text-xs text-[var(--color-tron-text)]">{data.tubeData.tubeId}</span>
					</div>
					<div class="mb-3 grid grid-cols-4 gap-3 text-center">
						<div>
							<p class="text-[10px] text-[var(--color-tron-text-secondary)]">Remaining</p>
							<p class="text-sm font-bold text-[var(--color-tron-text)]">{data.tubeData.remainingVolumeUl}µL</p>
						</div>
						<div>
							<p class="text-[10px] text-[var(--color-tron-text-secondary)]">Initial</p>
							<p class="text-sm text-[var(--color-tron-text-secondary)]">{data.tubeData.initialVolumeUl}µL</p>
						</div>
						<div>
							<p class="text-[10px] text-[var(--color-tron-text-secondary)]">Cartridges Filled</p>
							<p class="text-sm font-bold text-[var(--color-tron-text)]">{data.tubeData.totalCartridgesFilled}</p>
						</div>
						<div>
							<p class="text-[10px] text-[var(--color-tron-text-secondary)]">Runs Used</p>
							<p class="text-sm font-bold text-[var(--color-tron-text)]">{data.tubeData.totalRunsUsed}</p>
						</div>
					</div>
					<!-- Volume bar -->
					<div class="h-3 w-full overflow-hidden rounded-full bg-[var(--color-tron-border)]">
						<div class="h-full rounded-full transition-all {barColor}" style="width: {pct}%"></div>
					</div>
					<div class="mt-1 flex justify-between text-[10px] text-[var(--color-tron-text-secondary)]">
						<span>{pct.toFixed(0)}% remaining</span>
						<span class="tron-badge text-[10px] {data.tubeData.status === 'Active' ? 'tron-badge-success' : data.tubeData.status === 'Depleted' ? 'tron-badge-error' : 'tron-badge-neutral'}">{data.tubeData.status}</span>
					</div>
					{#if maxCartridges < 48}
						<div class="mt-2 rounded border border-amber-500/30 bg-amber-900/20 px-3 py-1.5 text-xs text-amber-300">
							Tube running low — ~{maxCartridges} cartridges remaining
						</div>
					{/if}
				</div>
			{/if}

			</div>
	{/if}

	<!-- Stage content: always rendered (not destroyed during submission) -->
	{#if displayStage}
	<div class="relative">
		{#if submitting && !previewParam}
			<div class="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/30">
				<div class="rounded-lg bg-[var(--color-tron-surface)] p-4 text-center shadow-lg">
					<div class="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-[var(--color-tron-cyan)] border-t-transparent"></div>
					<p class="text-sm text-[var(--color-tron-text-secondary)]">Processing...</p>
					{#if submittingTooLong}
						<button
							type="button"
							onclick={forceReload}
							class="mt-4 rounded-lg border border-[var(--color-tron-orange)]/50 bg-[var(--color-tron-orange)]/10 px-4 py-2 text-sm font-medium text-[var(--color-tron-orange)] transition-colors hover:bg-[var(--color-tron-orange)]/20"
						>
							Taking too long? Force Reload
						</button>
					{/if}
				</div>
			</div>
		{/if}
		{#if displayStage === 'Setup'}
			<SetupConfirmation
				incubatorTempC={data.settings.incubatorTempC}
				heaterTempC={data.settings.heaterTempC}
				onComplete={handleSetupComplete}
				readonly={isPreviewOrPast}
			/>
		{:else if displayStage === 'Loading' && displayLoadingSub === 'wax_prep'}
			<WaxPreparation onComplete={handleWaxPrepComplete} readonly={isPreviewOrPast} />
		{:else if displayStage === 'Loading' && displayLoadingSub === 'ready_to_run'}
			<!-- Deck loaded, ready to start run -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6">
				<div class="flex flex-col items-center gap-4">
					<div
						class="flex h-16 w-16 items-center justify-center rounded-full bg-green-900/30 text-green-400"
					>
						<svg class="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
						</svg>
					</div>
					<h3 class="text-lg font-semibold text-[var(--color-tron-text)]">Deck Loaded</h3>
					<p class="text-sm text-[var(--color-tron-text-secondary)]">
						Deck {previewParam ? 'DECK-PREVIEW' : data.runState.deckId} is loaded and ready. Proceed to run execution.
					</p>
					{#if !isPreviewOrPast}
						<div class="flex flex-col items-center gap-2">
							<button
								type="button"
								onclick={handleRunStarted}
								disabled={submitting}
								class="min-h-[44px] rounded-lg bg-[var(--color-tron-cyan)] px-8 py-3 text-base font-semibold text-white transition-colors hover:bg-[var(--color-tron-cyan)]/80 disabled:opacity-50"
							>
								Start Run
							</button>
							<button
								type="button"
								onclick={handleResetToLoading}
								disabled={submitting}
								class="rounded border border-amber-500/40 px-4 py-2 text-xs text-amber-400 transition-colors hover:border-amber-500 hover:bg-amber-900/20 disabled:opacity-50"
							>
								↩ Reset to Deck Loading
							</button>
						</div>
					{/if}
				</div>
			</div>
		{:else if displayStage === 'Loading' && displayLoadingSub === 'deck_load'}
			<!-- Backing Lot Gate — must scan before deck loading is enabled -->
			{#if !previewParam}
				<div class="rounded-lg border {(lotConfirmed) ? 'border-green-500/40 bg-green-900/10' : 'border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-surface)]'} p-4 space-y-3 mb-4">
					<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">Step 1 — Scan Backing Lot Barcode</h3>
					{#if lotConfirmed}
						<div class="flex items-center gap-2">
							<span class="inline-block h-2.5 w-2.5 rounded-full bg-green-500" aria-hidden="true"></span>
							<span class="text-sm text-green-400 font-medium">Lot confirmed:</span>
							<span class="font-mono text-sm text-[var(--color-tron-cyan)]">{confirmedLotId ?? data.activeLotId}</span>
							{#if confirmedLotCount}
								<span class="text-xs text-[var(--color-tron-text-secondary)]">({confirmedLotCount} cartridges)</span>
							{/if}
							<button type="button" onclick={() => { confirmedLotId = null; confirmedLotCount = null; lotScanSuccess = false; lotScanError = ''; }}
								class="ml-auto text-xs text-[var(--color-tron-text-secondary)] underline hover:text-[var(--color-tron-text)]">
								Change
							</button>
						</div>
					{:else}
						<p class="text-xs text-[var(--color-tron-text-secondary)]">
							Scan the Avery lot barcode from the box. Lot must have been in the oven for ≥ {data.minOvenTimeMin} minutes.
						</p>
						{#if lotScanError}
							<div class="rounded border border-red-500/30 bg-red-900/20 px-3 py-2 text-xs text-red-300">
								{lotScanError}
								{#if pendingOverrideAction === 'scanBackingLot'}
									<div class="mt-2 flex flex-wrap items-center gap-2">
										<button type="button"
											onclick={() => { showOverrideModal = true; overrideError = ''; }}
											class="rounded bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700">
											Admin Override
										</button>
										<button type="button"
											onclick={() => { lotScanError = ''; lotScanInput = ''; pendingOverrideAction = ''; pendingOverrideData = {}; }}
											class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)]">
											Pick another bucket
										</button>
									</div>
								{/if}
							</div>
						{/if}
						<div class="flex items-center gap-3">
							<input
								type="text"
								class="tron-input flex-1"
								placeholder="Scan lot barcode..."
								bind:value={lotScanInput}
								onkeydown={handleLotScanKeydown}
								autocomplete="off"
								autofocus
								disabled={lotScanSubmitting}
							/>
							<button
								type="button"
								onclick={handleScanBackingLot}
								disabled={lotScanSubmitting || !lotScanInput.trim()}
								class="min-h-[44px] rounded-lg bg-[var(--color-tron-cyan)] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-tron-cyan)]/80 disabled:opacity-50"
							>
								{lotScanSubmitting ? 'Checking...' : 'Verify'}
							</button>
						</div>
						<!-- Test override toggle -->
						<label class="flex items-center gap-2 text-xs text-amber-400 cursor-pointer">
							<input type="checkbox" bind:checked={lotOverride} class="rounded" />
							Test Override (skip oven time check, auto-create lot)
						</label>
						<!-- Quick-pick from ready lots -->
						{#if data.ovenLots.filter(l => l.ready).length > 0}
							<div class="text-xs text-[var(--color-tron-text-secondary)]">
								<span class="text-green-400">Ready:</span>
								{#each data.ovenLots.filter(l => l.ready) as ol}
									<button type="button" onclick={() => { lotScanInput = ol.lotId; handleScanBackingLot(); }}
										class="ml-1 font-mono text-[var(--color-tron-cyan)] underline hover:no-underline">
										{ol.lotId}{ol.ovenName ? ` @ ${ol.ovenName}` : ''}
									</button>
								{/each}
							</div>
						{/if}
						<!-- Still curing -->
						{#if data.ovenLots.filter(l => !l.ready).length > 0}
							<div class="text-xs text-[var(--color-tron-text-secondary)]">
								<span class="text-amber-400">Still curing:</span>
								{#each data.ovenLots.filter(l => !l.ready) as ol}
									<span class="ml-1 font-mono">
										{ol.lotId}{ol.ovenName ? ` @ ${ol.ovenName}` : ''}
										<span class="text-amber-400">— {ol.remainingMin ?? 0} min left</span>
									</span>
								{/each}
							</div>
						{/if}
					{/if}
				</div>
			{/if}

			<!-- Deck loading grid — only enabled after lot confirmed (or in preview) -->
			{#if previewParam || lotConfirmed}
				<DeckLoadingGrid
					availableLots={previewParam ? [{ lotId: 'LOT-PREVIEW', ready: true, cartridgeCount: 24 }] : (confirmedLotId ? [{ lotId: confirmedLotId, ready: true, cartridgeCount: confirmedLotCount ?? 0 }] : data.ovenLots.filter(l => l.ready))}
					plannedCartridgeCount={previewParam ? 24 : data.runState.plannedCartridgeCount}
					onComplete={handleDeckLoadComplete}
					readonly={isPreviewOrPast}
					suppressFocus={showCancelModal || showOverrideModal}
				/>
			{:else}
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center">
					<p class="text-sm text-[var(--color-tron-text-secondary)]">
						Scan the backing lot barcode above to unlock cartridge scanning.
					</p>
				</div>
			{/if}
		{:else if displayStage === 'Running'}
			<RunExecution
				runDurationMin={data.settings.runDurationMin}
				removeDeckWarningMin={data.settings.removeDeckWarningMin}
				runId={previewParam ? 'WXR-PREVIEW' : (data.runState.runId ?? '')}
				serverRunStartTime={previewParam ? new Date() : (data.runState.runStartTime ? new Date(data.runState.runStartTime) : null)}
				serverRunEndTime={previewParam ? new Date(Date.now() + 600000) : (data.runState.runEndTime ? new Date(data.runState.runEndTime) : null)}
				onRunStarted={handleRunStarted}
				onDeckRemoved={handleDeckRemoved}
				onAborted={handleAborted}
				readonly={isPreviewOrPast}
			/>
		{:else if displayStage === 'Awaiting Removal'}
			<PostRunCooling
				runEndTime={previewParam ? new Date() : (data.runState.deckRemovedTime ? new Date(data.runState.deckRemovedTime) : (data.runState.runEndTime ? new Date(data.runState.runEndTime) : new Date()))}
				coolingWarningMin={data.settings.coolingWarningMin}
				deckLockoutMin={data.settings.deckLockoutMin}
				onComplete={handleCoolingComplete}
				readonly={isPreviewOrPast}
				suppressFocus={showCancelModal || showOverrideModal}
			/>
		{:else if displayStage === 'QC'}
			{@const qcCarts = previewParam ? mockQcCartridges : data.qcCartridges.map((c) => ({
				...c,
				ovenEntryTime: c.ovenEntryTime ? new Date(c.ovenEntryTime) : null,
				qcTimestamp: c.qcTimestamp ? new Date(c.qcTimestamp) : null,
				storageTimestamp: c.storageTimestamp ? new Date(c.storageTimestamp) : null,
				createdAt: new Date(c.createdAt),
				updatedAt: new Date(c.updatedAt)
			}))}
			{#if !previewParam && !coolingComplete}
				<div class="rounded-lg border border-blue-500/50 bg-blue-900/20 p-5 text-center">
					<p class="text-sm font-medium text-blue-300">Cooling in progress — inspection locked</p>
					<p class="mt-2 font-mono text-3xl font-bold text-blue-200">Cooling: {coolingCountdown} remaining before inspection</p>
					<p class="mt-2 text-xs text-blue-400/70">Cartridges must cool for 10 minutes before QC inspection can begin.</p>
					{#if !showCoolingBypass}
						<button type="button" onclick={() => { showCoolingBypass = true; }} class="mt-3 text-xs text-blue-400/50 hover:text-blue-300 transition-colors">
							Admin Override
						</button>
					{:else}
						<div class="mt-3 flex items-center justify-center gap-2">
							<input
								type="password"
								bind:value={coolingBypassPassword}
								placeholder="Admin password..."
								class="rounded border border-blue-500/30 bg-blue-900/30 px-3 py-1.5 text-sm text-blue-200 placeholder:text-blue-400/40 focus:border-blue-400 focus:outline-none"
								onkeydown={(e) => { if (e.key === 'Enter') handleCoolingBypass(); }}
							/>
							<button type="button" onclick={handleCoolingBypass} class="rounded bg-blue-500/20 px-3 py-1.5 text-sm text-blue-300 hover:bg-blue-500/30">
								Bypass
							</button>
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
					readonly={isPreviewOrPast}
					coolingConfirmedAt={previewParam ? null : (data.runState.coolingConfirmedAt ? new Date(data.runState.coolingConfirmedAt) : null)}
					{coolingBypassed}
					runId={data.runState.runId ?? ''}
					lotId={data.runState.activeLotId ?? null}
				/>
			{:else}
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center">
					<p class="text-sm text-[var(--color-tron-text-secondary)]">
						No cartridges found for QC inspection. The cooling tray may not have been assigned yet.
					</p>
				</div>
			{/if}
		{:else if displayStage === 'Storage'}
			{@const storageCarts = previewParam ? mockStorageCartridges : data.storageCartridges}
			{@const summary = {
				runId: previewParam ? 'WXR-PREVIEW' : (data.runState.runId ?? ''),
				cartridgeCount: storageCarts.length,
				acceptedCount: storageCarts.filter((c) => c.qcStatus === 'Accepted').length,
				rejectedCount: storageCarts.filter((c) => c.qcStatus === 'Rejected').length
			}}
			<CompletionStorage
				cartridges={storageCarts}
				runSummary={summary}
				fridges={data.fridges}
				onRecordStorage={handleRecordStorage}
				onComplete={handleCompleteRun}
				readonly={isPreviewOrPast}
			/>
		{/if}
	</div>
	{/if}

	<!-- Cancel Run Modal -->
	{#if showCancelModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div class="mx-4 w-full max-w-md rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 shadow-xl">
				<h3 class="text-lg font-semibold text-[var(--color-tron-text)]">Cancel Run</h3>
				<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
					Are you sure you want to cancel run {data.runState.runId}? This action cannot be undone.
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
						onclick={handleCancelRun}
						disabled={!cancelReason.trim() || submitting}
						class="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
					>
						{submitting ? 'Cancelling...' : 'Confirm Cancel'}
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
							submitAction(pendingOverrideAction, {
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
</div>
