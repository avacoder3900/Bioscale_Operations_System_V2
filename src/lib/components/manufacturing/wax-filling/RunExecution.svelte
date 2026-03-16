<script lang="ts">
	import FinishTimerButton from '$lib/components/ui/FinishTimerButton.svelte';
	import { generateTestBarcode } from '$lib/utils/test-barcode';

	interface Props {
		runDurationMin: number;
		removeDeckWarningMin: number;
		runId: string;
		serverRunStartTime?: Date | null;
		serverRunEndTime?: Date | null;
		onRunStarted: () => void;
		onDeckRemoved: () => void;
		onAborted: (data: {
			usableCartridgeIds: string[];
			scrapCartridgeIds: string[];
			scrapReason: string;
			columnsCompleted: number;
		}) => void;
		readonly?: boolean;
	}

	let {
		runDurationMin = 30,
		removeDeckWarningMin = 3,
		runId,
		serverRunStartTime = null,
		serverRunEndTime = null,
		onRunStarted,
		onDeckRemoved,
		onAborted,
		readonly: isReadonly = false
	}: Props = $props();

	type Phase =
		| 'idle'
		| 'running'
		| 'remove_deck'
		| 'overdue'
		| 'abort_confirm1'
		| 'abort_confirm2'
		| 'abort_recovery';

	// Derive initial phase from server state
	function getInitialPhase(): Phase {
		if (!serverRunStartTime) return 'idle';
		if (serverRunEndTime && Date.now() >= serverRunEndTime.getTime()) {
			const overdueSinceMs = Date.now() - serverRunEndTime.getTime();
			if (overdueSinceMs >= removeDeckWarningMin * 60_000) return 'overdue';
			return 'remove_deck';
		}
		return 'running';
	}

	let phase = $state<Phase>(getInitialPhase());
	let startTime = $state<number | null>(serverRunStartTime?.getTime() ?? null);
	let tick = $state(0);

	// Abort recovery state
	let usableScans = $state<string[]>([]);
	let scrapReason = $state('');
	let usableInput = $state('');
	let usableInputEl: HTMLInputElement | undefined = $state();
	let columnsCompleted = $state(0);

	const totalMs = $derived(runDurationMin * 60_000);
	const overdueMs = $derived(removeDeckWarningMin * 60_000);

	const remaining = $derived.by(() => {
		void tick;
		if (!startTime) return totalMs;
		const elapsed = Date.now() - startTime;
		return Math.max(0, totalMs - elapsed);
	});

	const isFinished = $derived(remaining <= 0 && startTime !== null);

	const overdueSince = $derived.by(() => {
		void tick;
		if (!isFinished || !startTime) return 0;
		const finishTime = startTime + totalMs;
		return Math.max(0, Date.now() - finishTime);
	});

	const isOverdue = $derived(overdueSince >= overdueMs && isFinished);

	const minutes = $derived(Math.floor(remaining / 60_000));
	const seconds = $derived(Math.floor((remaining % 60_000) / 1000));
	const timerDisplay = $derived(
		`${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
	);

	const overdueMinDisplay = $derived(Math.floor(overdueSince / 60_000));
	const overdueSecDisplay = $derived(Math.floor((overdueSince % 60_000) / 1000));
	const overdueDisplay = $derived(
		`${String(overdueMinDisplay).padStart(2, '0')}:${String(overdueSecDisplay).padStart(2, '0')}`
	);

	// Timer tick
	$effect(() => {
		if (phase === 'running' || phase === 'remove_deck' || phase === 'overdue') {
			const interval = setInterval(() => {
				tick++;
			}, 1000);
			return () => clearInterval(interval);
		}
	});

	// Phase transitions based on timer state
	$effect(() => {
		void tick;
		if (phase === 'running' && isFinished) {
			phase = 'remove_deck';
		}
		if (phase === 'remove_deck' && isOverdue) {
			phase = 'overdue';
		}
	});

	function handleFinishTimer() {
		// Force timer to 0 and skip directly to deck removal phase
		if (startTime) {
			startTime = Date.now() - totalMs - 1000;
			tick++;
		}
		phase = 'remove_deck';
	}

	function handleStart() {
		startTime = Date.now();
		phase = 'running';
		onRunStarted();
	}

	function handleDeckRemoved() {
		onDeckRemoved();
	}

	function handleAbortStep1() {
		phase = 'abort_confirm1';
	}

	function handleAbortStep2() {
		phase = 'abort_confirm2';
	}

	function handleAbortConfirmed() {
		phase = 'abort_recovery';
	}

	function handleAbortCancel() {
		if (isOverdue) phase = 'overdue';
		else if (isFinished) phase = 'remove_deck';
		else phase = 'running';
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
			setTimeout(
				() => {
					osc.stop();
					ctx.close();
				},
				success ? 100 : 300
			);
		} catch {
			/* Audio not supported */
		}
	}

	function handleUsableKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && usableInput.trim()) {
			e.preventDefault();
			const scanned = usableInput.trim();
			if (usableScans.includes(scanned)) {
				playBeep(false);
			} else {
				usableScans = [...usableScans, scanned];
				playBeep(true);
			}
			usableInput = '';
		}
	}

	function removeUsable(id: string) {
		usableScans = usableScans.filter((s) => s !== id);
	}

	function handleRecoveryNoUsable() {
		onAborted({
			usableCartridgeIds: [],
			scrapCartridgeIds: [],
			scrapReason: scrapReason || 'Run aborted',
			columnsCompleted
		});
	}

	function handleRecoveryComplete() {
		onAborted({
			usableCartridgeIds: usableScans,
			scrapCartridgeIds: [],
			scrapReason: scrapReason || 'Run aborted',
			columnsCompleted
		});
	}

	function handleUsableBlur() {
		if (phase === 'abort_recovery') setTimeout(() => usableInputEl?.focus(), 100);
	}

	$effect(() => {
		if (phase === 'abort_recovery' && usableInputEl) usableInputEl.focus();
	});


</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Run Execution</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Run ID: <span class="font-mono text-[var(--color-tron-cyan)]">{runId}</span>
	</p>

	<!-- Idle: Start Run -->
	{#if phase === 'idle'}
		<div class="flex flex-col items-center gap-6 py-8">
			<div class="font-mono text-6xl font-bold text-[var(--color-tron-text-secondary)]">
				{timerDisplay}
			</div>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Run duration: {runDurationMin} minutes
			</p>
			<button
				type="button"
				onclick={handleStart}
				class="min-h-[44px] w-full max-w-sm rounded-lg border border-green-500/50 bg-green-900/20 px-8 py-4 text-lg font-bold text-green-400 transition-all hover:bg-green-900/30"
			>
				Start Run
			</button>
		</div>
	{/if}

	<!-- Running: Countdown Timer -->
	{#if phase === 'running'}
		<div class="flex flex-col items-center gap-6 py-8">
			<div class="font-mono text-7xl font-bold text-[var(--color-tron-cyan)]">
				{timerDisplay}
			</div>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">Robot is filling cartridges...</p>
			<div class="flex gap-3">
				<FinishTimerButton onFinish={handleFinishTimer} />
				<button
					type="button"
					onclick={handleAbortStep1}
					class="min-h-[44px] rounded-lg border border-red-500/50 bg-red-900/20 px-6 py-3 text-sm font-semibold text-red-400 transition-all hover:bg-red-900/30"
				>
					Abort Run
				</button>
			</div>
		</div>
	{/if}

	<!-- Remove Deck Alert -->
	{#if phase === 'remove_deck'}
		<div class="flex flex-col items-center gap-6 py-4">
			<div class="animate-pulse rounded-xl border-2 border-red-500 bg-red-900/30 p-6 text-center">
				<svg
					class="mx-auto mb-3 h-12 w-12 text-red-400"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					stroke-width="2"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
					/>
				</svg>
				<p class="text-2xl font-bold text-red-400">REMOVE DECK NOW</p>
				<p class="mt-1 text-sm text-red-300">Run complete — remove the deck from the robot</p>
			</div>

			<button
				type="button"
				onclick={handleDeckRemoved}
				class="min-h-[44px] w-full max-w-sm rounded-lg border border-green-500/50 bg-green-900/20 px-8 py-4 text-lg font-bold text-green-400 transition-all hover:bg-green-900/30"
			>
				Deck Removed
			</button>
			<button
				type="button"
				onclick={handleAbortStep1}
				class="min-h-[44px] rounded-lg border border-red-500/50 bg-red-900/20 px-6 py-3 text-sm font-semibold text-red-400 transition-all hover:bg-red-900/30"
			>
				Abort Run
			</button>
		</div>
	{/if}

	<!-- OVERDUE Warning -->
	{#if phase === 'overdue'}
		<div class="flex flex-col items-center gap-6 py-4">
			<div class="w-full rounded-xl border-4 border-red-600 bg-red-950/50 p-8 text-center">
				<p class="text-4xl font-black text-red-500">OVERDUE</p>
				<p class="mt-2 font-mono text-lg font-bold text-red-400">
					+{overdueDisplay} past removal deadline
				</p>
				<p class="mt-2 text-sm text-red-300">
					Deck should have been removed {removeDeckWarningMin} min after run ended
				</p>
			</div>

			<button
				type="button"
				onclick={handleDeckRemoved}
				class="min-h-[44px] w-full max-w-sm animate-pulse rounded-lg border-2 border-green-500 bg-green-900/30 px-8 py-4 text-lg font-bold text-green-400 transition-all hover:bg-green-900/40"
			>
				Deck Removed
			</button>
			<button
				type="button"
				onclick={handleAbortStep1}
				class="min-h-[44px] rounded-lg border border-red-500/50 bg-red-900/20 px-6 py-3 text-sm font-semibold text-red-400 transition-all hover:bg-red-900/30"
			>
				Abort Run
			</button>
		</div>
	{/if}

	<!-- Abort Confirmation 1 -->
	{#if phase === 'abort_confirm1'}
		<div class="rounded-xl border border-red-500/50 bg-red-900/10 p-6 text-center">
			<svg
				class="mx-auto mb-3 h-10 w-10 text-red-400"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				stroke-width="2"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
				/>
			</svg>
			<p class="text-lg font-bold text-red-400">Are you sure?</p>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				Aborting will stop the run and require cartridge recovery.
			</p>
			<div class="mt-5 flex gap-3">
				<button
					type="button"
					onclick={handleAbortCancel}
					class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-3 text-sm font-medium text-[var(--color-tron-text)] transition-all hover:border-[var(--color-tron-cyan)]/30"
				>
					Cancel
				</button>
				<button
					type="button"
					onclick={handleAbortStep2}
					class="min-h-[44px] flex-1 rounded-lg border border-red-500/50 bg-red-900/20 px-4 py-3 text-sm font-bold text-red-400 transition-all hover:bg-red-900/30"
				>
					Yes, Abort
				</button>
			</div>
		</div>
	{/if}

	<!-- Abort Confirmation 2 -->
	{#if phase === 'abort_confirm2'}
		<div class="rounded-xl border-2 border-red-600 bg-red-900/20 p-6 text-center">
			<p class="text-lg font-bold text-red-500">This cannot be undone. Confirm abort?</p>
			<p class="mt-1 text-sm text-red-300">All cartridges in this run will need recovery.</p>
			<div class="mt-5 flex gap-3">
				<button
					type="button"
					onclick={handleAbortCancel}
					class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-3 text-sm font-medium text-[var(--color-tron-text)] transition-all hover:border-[var(--color-tron-cyan)]/30"
				>
					Cancel
				</button>
				<button
					type="button"
					onclick={handleAbortConfirmed}
					class="min-h-[44px] flex-1 rounded-lg border-2 border-red-600 bg-red-900/30 px-4 py-3 text-sm font-black text-red-400 transition-all hover:bg-red-900/40"
				>
					CONFIRM ABORT
				</button>
			</div>
		</div>
	{/if}

	<!-- Abort Recovery -->
	{#if phase === 'abort_recovery'}
		<div class="space-y-5 rounded-xl border border-amber-500/50 bg-amber-900/10 p-6">
			<div>
				<p class="text-lg font-bold text-amber-400">Cartridge Recovery</p>
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
					Are any cartridges usable? Scan usable cartridge barcodes below. Unscanned cartridges
					return to Oven Queue. Remaining will be scrapped.
				</p>
			</div>

			<!-- Columns completed input -->
			<div>
				<label for="columns-completed" class="tron-label">How many columns were filled before abort?</label>
				<input
					id="columns-completed"
					type="number"
					min="0"
					max="3"
					class="tron-input"
					style="max-width: 120px;"
					bind:value={columnsCompleted}
				/>
				<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
					{columnsCompleted} of 3 columns filled. Wax for {3 - columnsCompleted} unfilled column{3 - columnsCompleted !== 1 ? 's' : ''} will be refunded to the incubator tube.
				</p>
			</div>

			<!-- Scrap reason input -->
			<div>
				<label for="scrap-reason" class="tron-label">Abort / Scrap Reason</label>
				<input
					id="scrap-reason"
					type="text"
					class="tron-input"
					placeholder="Enter reason for abort..."
					bind:value={scrapReason}
				/>
			</div>

			<!-- Usable cartridge scan -->
			<div>
				<label for="usable-scan" class="tron-label">Scan Usable Cartridges</label>
				<div class="flex gap-2">
					<input
						bind:this={usableInputEl}
						id="usable-scan"
						type="text"
						class="tron-input flex-1"
						placeholder="Scan usable cartridge barcode..."
						bind:value={usableInput}
						onkeydown={handleUsableKeydown}
						onblur={handleUsableBlur}
						autocomplete="off"
					/>
					<button
						type="button"
						onclick={() => { usableInput = generateTestBarcode('CART'); handleUsableKeydown(new KeyboardEvent('keydown', { key: 'Enter' })); }}
						class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]"
					>
						Test
					</button>
				</div>
			</div>

			{#if usableScans.length > 0}
				<div class="space-y-1.5">
					<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">
						Usable cartridges ({usableScans.length}):
					</p>
					<div class="flex flex-wrap gap-2">
						{#each usableScans as id (id)}
							<span
								class="inline-flex items-center gap-1.5 rounded-md border border-green-500/30 bg-green-900/20 px-2 py-1 font-mono text-xs text-green-400"
							>
								{id}
								<button
									type="button"
									onclick={() => removeUsable(id)}
									class="ml-0.5 text-green-500 hover:text-green-300"
									aria-label="Remove {id}"
								>
									&times;
								</button>
							</span>
						{/each}
					</div>
				</div>
			{/if}

			<div class="flex gap-3">
				<button
					type="button"
					onclick={handleRecoveryNoUsable}
					class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-3 text-sm font-medium text-[var(--color-tron-text)] transition-all hover:border-[var(--color-tron-cyan)]/30"
				>
					No Usable Cartridges
				</button>
				{#if usableScans.length > 0}
					<button
						type="button"
						onclick={handleRecoveryComplete}
						class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
					>
						Confirm Recovery ({usableScans.length} usable)
					</button>
				{/if}
			</div>
		</div>
	{/if}
</div>
