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
		 * The OT-2's terminal status ('succeeded' | 'failed' | 'stopped' | null).
		 * Load-bearing (2026-08-31): `robotFinished` is true for ANY terminal
		 * state, so the panel used to shout "Filling Complete" in green after a
		 * run that errored out during tip calibration without dispensing a drop —
		 * and the Done button beneath it stamps every cartridge reagent_filled.
		 */
		finalStatus?: string | null;
		/**
		 * Fall back to treating the estimate as a deadline: when it expires, call
		 * onTimerComplete. Only for runs with no OT-2 run linked, where there is
		 * no robot status to wait on.
		 */
		autoCompleteOnExpiry?: boolean;
		/**
		 * The robot is paused. The clock holds while this is true — a paused robot
		 * is not filling, so counting that time would both misreport how long the
		 * fill took and eat the remaining estimate for work that never happened.
		 */
		paused?: boolean;
	}

	let {
		assayTypeName, cartridgeCount, runStartTime, runEndTime, onTimerComplete, onAbort,
		readonly: isReadonly = false, protocolParameters = null,
		robotFinished = false, autoCompleteOnExpiry = false, paused = false,
		finalStatus = null
	}: Props = $props();

	let now = $state(Date.now());
	let showAbortModal = $state(false);
	let abortReason = $state('');
	let abortPhotoUrl = $state('');
	let manuallyFinished = $state(false);

	// The countdown is the headline number, but it is still only an estimate: it
	// never decides that the run is over. Only the robot (or the operator via
	// Finish) does. An estimate that expires early used to declare "Filling
	// Complete" while the pipette was still moving, so when this hits zero it
	// keeps counting UP as "+MM:SS over" instead of claiming the fill is done.
	// Viewing a finished run: runEndTime is its real finish time (the completion
	// actions overwrite the estimate with the actual), so freeze the clock there
	// rather than letting the stopwatch keep climbing.
	const clock = $derived(isReadonly ? new Date(runEndTime).getTime() : now);

	// Time the robot spent paused, which is not fill time. Accumulated across
	// however many times the operator pauses, plus the stretch currently open.
	let pausedAccumMs = $state(0);
	let pausedSince = $state<number | null>(null);
	$effect(() => {
		if (paused && pausedSince === null) {
			pausedSince = Date.now();
		} else if (!paused && pausedSince !== null) {
			pausedAccumMs += Date.now() - pausedSince;
			pausedSince = null;
		}
	});
	const pausedMs = $derived(pausedAccumMs + (pausedSince !== null ? Math.max(0, clock - pausedSince) : 0));

	// runEndTime - runStartTime is the DURATION the estimate budgeted. Remaining is
	// measured against that budget rather than against the wall-clock end stamp, so
	// a pause pushes the finish out instead of silently burning the estimate down.
	const estimateMs = $derived(new Date(runEndTime).getTime() - new Date(runStartTime).getTime());
	const elapsedMs = $derived(Math.max(0, clock - new Date(runStartTime).getTime() - pausedMs));
	const remainingMs = $derived(Math.max(0, estimateMs - elapsedMs));
	const progress = $derived(estimateMs > 0 ? Math.min(1, elapsedMs / estimateMs) : 0);
	const pastEstimate = $derived(!isReadonly && estimateMs > 0 && elapsedMs >= estimateMs);

	const complete = $derived(isReadonly || robotFinished || manuallyFinished);
	/** Terminal but NOT successful — the fill did not happen (or not fully). */
	const failedRun = $derived(
		!!finalStatus && !['succeeded', 'completed'].includes(String(finalStatus).toLowerCase())
	);

	const elapsedMin = $derived(Math.floor(elapsedMs / 60000));
	const elapsedSec = $derived(Math.floor((elapsedMs % 60000) / 1000));
	const estimateMin = $derived(Math.round(estimateMs / 60000));

	// The countdown itself, and — once it runs out — how far past the estimate we
	// are. The clock keeps meaning something after zero instead of just sitting
	// there: the run isn't over until the robot says so.
	const countdownMin = $derived(Math.floor(remainingMs / 60000));
	const countdownSec = $derived(Math.floor((remainingMs % 60000) / 1000));
	const overMs = $derived(Math.max(0, elapsedMs - estimateMs));
	const overMin = $derived(Math.floor(overMs / 60000));
	const overSec = $derived(Math.floor((overMs % 60000) / 1000));

	const pad = (n: number) => String(n).padStart(2, '0');

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

	<!-- Countdown to the estimated finish, with elapsed underneath so the number
	     the countdown is derived from stays visible. Past zero it flips to
	     "+MM:SS over" rather than pretending the fill is done. -->
	<div class="rounded-xl border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center">
		{#if complete && failedRun}
			<div class="space-y-2">
				<div class="text-2xl font-bold text-red-400">Run did not complete</div>
				<p class="text-sm text-[var(--color-tron-text-secondary)]">
					The robot ended in "{finalStatus}" after {elapsedMin}:{pad(elapsedSec)}. See "Why it failed"
					above. Cartridges have NOT been reagent-filled — fix the cause and run them again.
				</p>
			</div>
		{:else if complete}
			<div class="space-y-2">
				<div class="text-2xl font-bold text-green-400">Filling Complete</div>
				<p class="text-sm text-[var(--color-tron-text-secondary)]">
					Took {elapsedMin}:{pad(elapsedSec)}. Use the controls below to finish.
				</p>
			</div>
		{:else}
			<div class="text-5xl font-mono font-bold tabular-nums {paused ? 'text-yellow-300' : pastEstimate ? 'text-amber-300' : 'text-[var(--color-tron-cyan)]'}">
				{#if pastEstimate}
					+{pad(overMin)}:{pad(overSec)}
				{:else}
					{pad(countdownMin)}:{pad(countdownSec)}
				{/if}
			</div>
			<p class="mt-2 text-sm {paused ? 'text-yellow-300' : pastEstimate ? 'text-amber-300' : 'text-[var(--color-tron-text-secondary)]'}">
				{#if paused}
					paused — countdown held
				{:else if pastEstimate}
					over the ~{estimateMin} min estimate — waiting on the robot
				{:else}
					remaining (estimated)
				{/if}
			</p>

			<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				{elapsedMin}:{pad(elapsedSec)} elapsed{#if pausedAccumMs > 0 || pausedSince !== null}, not counting {Math.round(pausedMs / 60000)} min paused{/if}
			</p>
		{/if}

		<!-- Progress bar — position against the estimate, not a countdown to a deadline -->
		<div class="mt-4 h-2 w-full overflow-hidden rounded-full bg-[var(--color-tron-border)]">
			<div
				class="h-full rounded-full transition-all duration-1000 {complete && failedRun ? 'bg-red-500' : complete ? 'bg-green-500' : paused ? 'bg-yellow-400' : pastEstimate ? 'bg-amber-500' : 'bg-[var(--color-tron-cyan)]'}"
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
