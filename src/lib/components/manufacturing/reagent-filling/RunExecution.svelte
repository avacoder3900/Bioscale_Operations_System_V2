<script lang="ts">
	import { onDestroy } from 'svelte';
	import FinishTimerButton from '$lib/components/ui/FinishTimerButton.svelte';
	import { countReagentWork } from '$lib/manufacturing/reagent-run-estimate';

	interface Props {
		assayTypeName: string;
		cartridgeCount: number;
		runStartTime: Date;
		runEndTime: Date;
		onTimerComplete: () => void;
		onAbort: (reason: string, photoUrl?: string) => void;
		readonly?: boolean;
		/**
		 * The run-time parameters the run was started with. Used only to explain
		 * where the estimate came from ("4 rows × 24 cartridges = 288 wells").
		 */
		protocolParameters?: Record<string, unknown> | null;
		/**
		 * True once the OT-2 itself reports a terminal status. This — not the
		 * estimate running out — is what means "the filling is done".
		 */
		robotFinished?: boolean;
		/**
		 * Fall back to treating the estimate as a deadline: when it expires, call
		 * onTimerComplete. Only for runs with no OT-2 run linked, where there is
		 * no robot status to wait on.
		 */
		autoCompleteOnExpiry?: boolean;
	}

	let {
		assayTypeName, cartridgeCount, runStartTime, runEndTime, onTimerComplete, onAbort,
		readonly: isReadonly = false, protocolParameters = null,
		robotFinished = false, autoCompleteOnExpiry = false
	}: Props = $props();

	let now = $state(Date.now());
	let showAbortModal = $state(false);
	let abortReason = $state('');
	let abortPhotoUrl = $state('');
	let manuallyFinished = $state(false);

	// The estimate is an estimate: it drives the "remaining" hint and the progress
	// bar, never the "this run is over" decision. Only the robot (or the operator
	// via Finish) decides that — an estimate that expires early used to declare
	// "Filling Complete" while the pipette was still moving.
	// Viewing a finished run: runEndTime is its real finish time (the completion
	// actions overwrite the estimate with the actual), so freeze the clock there
	// rather than letting the stopwatch keep climbing.
	const clock = $derived(isReadonly ? new Date(runEndTime).getTime() : now);

	const estimateMs = $derived(new Date(runEndTime).getTime() - new Date(runStartTime).getTime());
	const elapsedMs = $derived(Math.max(0, clock - new Date(runStartTime).getTime()));
	const remainingMs = $derived(Math.max(0, new Date(runEndTime).getTime() - clock));
	const progress = $derived(estimateMs > 0 ? Math.min(1, elapsedMs / estimateMs) : 0);
	const pastEstimate = $derived(!isReadonly && estimateMs > 0 && remainingMs <= 0);

	const complete = $derived(isReadonly || robotFinished || manuallyFinished);

	const elapsedMin = $derived(Math.floor(elapsedMs / 60000));
	const elapsedSec = $derived(Math.floor((elapsedMs % 60000) / 1000));
	const remainingMin = $derived(Math.ceil(remainingMs / 60000));
	const estimateMin = $derived(Math.round(estimateMs / 60000));

	// Where the estimate came from, so an operator can sanity-check it rather than
	// having to trust a bare number.
	const work = $derived(countReagentWork(protocolParameters, cartridgeCount));

	// Beep when the run actually finishes, not when the estimate lapses. Skip the
	// beep on a page load of an already-finished run.
	let armed = false;
	let alarmPlayed = false;
	$effect(() => {
		if (!complete) { armed = true; return; }
		if (armed && !alarmPlayed) { alarmPlayed = true; playAlarm(); }
	});

	const interval = setInterval(() => {
		now = Date.now();
		if (autoCompleteOnExpiry && remainingMs <= 0 && !manuallyFinished) {
			manuallyFinished = true;
			onTimerComplete();
		}
	}, 1000);

	onDestroy(() => clearInterval(interval));

	function playAlarm() {
		try {
			const ctx = new AudioContext();
			for (let i = 0; i < 3; i++) {
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.connect(gain);
				gain.connect(ctx.destination);
				osc.frequency.value = 880;
				osc.type = 'sine';
				gain.gain.value = 0.4;
				osc.start(ctx.currentTime + i * 0.3);
				osc.stop(ctx.currentTime + i * 0.3 + 0.15);
			}
		} catch { /* audio not available */ }
	}

	function handleFinishTimer() {
		// Operator override — the robot hasn't reported terminal but they can see
		// the deck is done (or the poll is wedged).
		if (!manuallyFinished) {
			manuallyFinished = true;
			onTimerComplete();
		}
	}

	function submitAbort() {
		if (!abortReason.trim()) return;
		onAbort(abortReason.trim(), abortPhotoUrl.trim() || undefined);
		showAbortModal = false;
	}
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Run in Progress</h2>

	<div class="flex items-center gap-4 text-sm text-[var(--color-tron-text-secondary)]">
		<span>Assay: <strong class="text-[var(--color-tron-cyan)]">{assayTypeName}</strong></span>
		<span>Cartridges: <strong class="text-[var(--color-tron-text)]">{cartridgeCount}</strong></span>
	</div>

	<!-- Elapsed stopwatch. The big number is time actually spent, which is always
	     true; the estimate underneath is advisory. -->
	<div class="rounded-xl border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center">
		{#if complete}
			<div class="space-y-2">
				<div class="text-2xl font-bold text-green-400">Filling Complete</div>
				<p class="text-sm text-[var(--color-tron-text-secondary)]">
					Took {elapsedMin}:{String(elapsedSec).padStart(2, '0')}. Use the controls below to finish.
				</p>
			</div>
		{:else}
			<div class="text-5xl font-mono font-bold text-[var(--color-tron-cyan)] tabular-nums">
				{String(elapsedMin).padStart(2, '0')}:{String(elapsedSec).padStart(2, '0')}
			</div>
			<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">elapsed</p>

			{#if estimateMs > 0}
				<p class="mt-1 text-xs {pastEstimate ? 'text-amber-300' : 'text-[var(--color-tron-text-secondary)]'}">
					{#if pastEstimate}
						past the ~{estimateMin} min estimate — waiting on the robot to report finished
					{:else}
						~{remainingMin} min remaining (estimated)
					{/if}
				</p>
			{/if}
		{/if}

		<!-- Progress bar — position against the estimate, not a countdown to a deadline -->
		<div class="mt-4 h-2 w-full overflow-hidden rounded-full bg-[var(--color-tron-border)]">
			<div
				class="h-full rounded-full transition-all duration-1000 {complete ? 'bg-green-500' : pastEstimate ? 'bg-amber-500' : 'bg-[var(--color-tron-cyan)]'}"
				style="width: {complete ? 100 : progress * 100}%"
			></div>
		</div>

		{#if !complete && work.dispenses > 0 && estimateMs > 0}
			<p class="mt-3 text-[11px] text-[var(--color-tron-text-secondary)]">
				Estimate: {work.reagentGroups} reagent {work.reagentGroups === 1 ? 'row' : 'rows'}
				× {cartridgeCount} {cartridgeCount === 1 ? 'cartridge' : 'cartridges'}
				= {work.dispenses} wells, ~{estimateMin} min
			</p>
		{/if}
	</div>

	{#if !complete}
		<div class="flex gap-3">
			<FinishTimerButton onFinish={handleFinishTimer} />
			<button
				type="button"
				onclick={() => { showAbortModal = true; }}
				class="min-h-[44px] flex-1 rounded-lg border border-red-500/50 bg-red-900/20 px-6 py-3 text-sm font-semibold text-red-300 hover:bg-red-900/30"
			>
				Abort Run
			</button>
		</div>
	{/if}

	{#if showAbortModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
			<div class="w-full max-w-md rounded-xl border border-red-500/50 bg-[var(--color-tron-bg)] p-6 shadow-2xl">
				<h3 class="mb-4 text-lg font-semibold text-red-300">Abort Run</h3>
				<div class="space-y-3">
					<div>
						<label for="abort-reason" class="text-sm text-[var(--color-tron-text-secondary)]">Reason</label>
						<textarea
							id="abort-reason"
							bind:value={abortReason}
							rows={3}
							class="mt-1 min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
							placeholder="Describe the reason for aborting..."
						></textarea>
					</div>
					<div>
						<label for="abort-photo" class="text-sm text-[var(--color-tron-text-secondary)]">Photo URL (optional)</label>
						<input
							id="abort-photo"
							bind:value={abortPhotoUrl}
							class="mt-1 min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
							placeholder="Photo URL..."
						/>
					</div>
					<div class="flex gap-2 pt-2">
						<button type="button" onclick={() => { showAbortModal = false; }}
							class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]"
						>
							Cancel
						</button>
						<button type="button" onclick={submitAbort} disabled={!abortReason.trim()}
							class="min-h-[44px] flex-1 rounded border border-red-500/50 bg-red-900/30 px-4 py-2 text-sm font-semibold text-red-300 disabled:opacity-50"
						>
							Confirm Abort
						</button>
					</div>
				</div>
			</div>
		</div>
	{/if}
</div>
