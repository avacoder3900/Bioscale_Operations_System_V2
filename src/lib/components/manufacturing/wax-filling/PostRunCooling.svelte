<script lang="ts">
	interface Props {
		runEndTime: Date;
		coolingWarningMin: number;
		onComplete: () => void;
		readonly?: boolean;
	}

	let { runEndTime, coolingWarningMin = 7, onComplete, readonly: isReadonly = false }: Props = $props();

	let alarmPlaying = $state(false);
	let alarmDismissed = $state(false);
	let tick = $state(0);

	const elapsedMs = $derived.by(() => {
		void tick;
		return Date.now() - runEndTime.getTime();
	});

	const elapsedMin = $derived(Math.floor(elapsedMs / 60_000));
	const elapsedSec = $derived(Math.floor((elapsedMs % 60_000) / 1000));
	const elapsedDisplay = $derived(
		`${String(elapsedMin).padStart(2, '0')}:${String(elapsedSec).padStart(2, '0')}`
	);

	const isTransferOverdue = $derived(elapsedMin >= coolingWarningMin);

	// Alarm: play repeating beep when transfer overdue
	$effect(() => {
		if (isTransferOverdue && !alarmDismissed && !alarmPlaying) {
			alarmPlaying = true;
			const playAlarm = () => {
				try {
					const ctx = new AudioContext();
					const osc = ctx.createOscillator();
					const gain = ctx.createGain();
					osc.connect(gain);
					gain.connect(ctx.destination);
					osc.frequency.value = 880;
					gain.gain.value = 0.3;
					osc.start();
					setTimeout(() => { osc.stop(); ctx.close(); }, 500);
				} catch { /* audio not supported */ }
			};
			playAlarm();
			const interval = setInterval(() => {
				if (alarmDismissed) { clearInterval(interval); return; }
				playAlarm();
			}, 3000);
			return () => clearInterval(interval);
		}
	});

	// Timer tick for elapsed time
	$effect(() => {
		const interval = setInterval(() => {
			tick++;
		}, 1000);
		return () => clearInterval(interval);
	});
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Post-Run Cooling</h2>

	{#if isReadonly}
		<p class="rounded border border-[var(--color-tron-yellow)]/30 bg-[var(--color-tron-yellow)]/5 px-3 py-2 text-xs text-[var(--color-tron-yellow)]">Read-only — viewing past stage</p>
	{/if}

	<!-- Elapsed time since run ended -->
	<div
		class="rounded-lg border px-4 py-3 {isTransferOverdue
			? 'border-amber-500/50 bg-amber-900/20'
			: 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]'}"
	>
		<p
			class="text-xs font-medium {isTransferOverdue
				? 'text-amber-400'
				: 'text-[var(--color-tron-text-secondary)]'}"
		>
			Time since run ended
		</p>
		<p
			class="font-mono text-2xl font-bold {isTransferOverdue
				? 'text-amber-400'
				: 'text-[var(--color-tron-cyan)]'}"
		>
			{elapsedDisplay}
		</p>
		{#if isTransferOverdue}
			<div class="mt-2 rounded-lg border border-red-500/50 bg-red-900/20 px-4 py-3">
				<p class="text-sm font-bold text-red-400">⚠️ ALERT: Cartridges must be cooled within {coolingWarningMin} minutes!</p>
				<p class="mt-1 text-xs text-red-300">Move them into the cooler immediately.</p>
				{#if !alarmDismissed}
					<button type="button" onclick={() => { alarmDismissed = true; alarmPlaying = false; }} class="mt-2 rounded border border-red-500/30 px-3 py-1 text-xs text-red-300 hover:bg-red-900/30">
						Dismiss Alarm
					</button>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Single confirm: cartridges go straight into the cooler (WAX-FLOW-3 —
	     no tray or oven barcode scans) -->
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Remove the cartridges from the deck and place them directly into the cooler, then confirm below.
	</p>
	<button
		type="button"
		onclick={onComplete}
		disabled={isReadonly}
		class="min-h-[44px] w-full rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-4 text-lg font-bold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30 disabled:opacity-40"
	>
		Cartridges Placed in Cooler
	</button>
</div>
