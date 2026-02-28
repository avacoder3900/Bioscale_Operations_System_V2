<script lang="ts">
	import { onDestroy } from 'svelte';
	import FinishTimerButton from '$lib/components/ui/FinishTimerButton.svelte';

	interface Props {
		assayTypeName: string;
		cartridgeCount: number;
		runStartTime: Date;
		runEndTime: Date;
		onTimerComplete: () => void;
		onAbort: (reason: string, photoUrl?: string) => void;
		readonly?: boolean;
	}

	let { assayTypeName, cartridgeCount, runStartTime, runEndTime, onTimerComplete, onAbort, readonly: isReadonly = false }: Props = $props();

	let now = $state(Date.now());
	let showAbortModal = $state(false);
	let abortReason = $state('');
	let abortPhotoUrl = $state('');
	let timerComplete = $state(false);

	const totalMs = $derived(new Date(runEndTime).getTime() - new Date(runStartTime).getTime());
	const elapsedMs = $derived(Math.max(0, now - new Date(runStartTime).getTime()));
	const remainingMs = $derived(Math.max(0, new Date(runEndTime).getTime() - now));
	const progress = $derived(totalMs > 0 ? Math.min(1, elapsedMs / totalMs) : 0);

	const remainingMin = $derived(Math.floor(remainingMs / 60000));
	const remainingSec = $derived(Math.floor((remainingMs % 60000) / 1000));

	const interval = setInterval(() => {
		now = Date.now();
		if (remainingMs <= 0 && !timerComplete) {
			timerComplete = true;
			playAlarm();
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
		// Force timer to complete and immediately trigger the callback
		now = new Date(runEndTime).getTime() + 1000;
		if (!timerComplete) {
			timerComplete = true;
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

	<!-- Timer display -->
	<div class="rounded-xl border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center">
		{#if timerComplete}
			<div class="space-y-2">
				<div class="text-2xl font-bold text-green-400">Filling Complete</div>
				<p class="text-sm text-[var(--color-tron-text-secondary)]">Proceeding to inspection...</p>
			</div>
		{:else}
			<div class="text-5xl font-mono font-bold text-[var(--color-tron-cyan)] tabular-nums">
				{String(remainingMin).padStart(2, '0')}:{String(remainingSec).padStart(2, '0')}
			</div>
			<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">remaining</p>
		{/if}

		<!-- Progress bar -->
		<div class="mt-4 h-2 w-full overflow-hidden rounded-full bg-[var(--color-tron-border)]">
			<div
				class="h-full rounded-full transition-all duration-1000 {timerComplete ? 'bg-green-500' : 'bg-[var(--color-tron-cyan)]'}"
				style="width: {progress * 100}%"
			></div>
		</div>
	</div>

	{#if !timerComplete}
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
