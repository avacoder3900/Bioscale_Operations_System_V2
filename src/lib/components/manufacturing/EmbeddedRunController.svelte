<!--
  Embedded OT-2 run controller for use inside a manufacturing flow page.

  Mirrors the relevant pieces of /opentrons/runs/[runId]/+page.svelte
  (status display, current-command, play / pause / resume / cancel buttons)
  but stays in-page so wax / reagent filling don't lose their context.
  All actions go through the same /api/opentrons-lab/robots/:id/runs/:rid
  endpoints the clone already uses.

  When the run reaches a terminal status (succeeded / stopped / failed),
  onComplete is called once with the final status. The parent decides
  what state-machine transition to fire — this component never mutates
  BIMS state directly, only the OT-2's.

  Props:
    robotId          OpentronsRobot._id
    robotName        for display only
    opentronsRunId   the run UUID returned by POST /runs
    onComplete       (status, run) => void; called once when the run lands
                     in a terminal state
    pollMs           polling cadence (default 2000)
-->
<script lang="ts">
	import { onDestroy } from 'svelte';

	let {
		robotId,
		robotName = 'OT-2',
		opentronsRunId,
		onComplete,
		pollMs = 2000
	} = $props<{
		robotId: string;
		robotName?: string;
		opentronsRunId: string;
		onComplete?: (status: string, run: any) => void;
		pollMs?: number;
	}>();

	let run = $state<any>(null);
	let runStatus = $state<string>('idle');
	/** Set by a control action the operator pressed — always surfaced immediately. */
	let lastError = $state<string | null>(null);
	/** Set by the background poll — surfaced only once it stops being transient. */
	let pollError = $state<string | null>(null);
	let pollFailures = $state(0);
	let actionInFlight = $state<string | null>(null);
	let terminalFired = $state(false);
	// Auto-resume the initial "confirm off-deck labware" pause so operators don't
	// click resume at the start of the wax/reagent protocol. Fires once.
	let autoResumedInitial = $state(false);
	/**
	 * The operator asked for this pause. Auto-resume must never override it — that
	 * bug made Pause look broken: the daemon's own auto_resume_run almost always
	 * won the race for the initial off-deck pause, so the browser never observed
	 * it, autoResumedInitial stayed false, and the first pause the browser ever saw
	 * was the operator's — which it immediately resumed.
	 */
	let operatorPaused = $state(false);
	/**
	 * Pause is requested but the robot has not reported `paused` yet. The OT-2
	 * finishes its current command first, which for a fill is a whole
	 * aspirate/dispense sequence, so this can take a few seconds. Held separately
	 * because the reconcile poll would otherwise overwrite the optimistic status
	 * with `running` and make it look like the click did nothing.
	 */
	let pausePending = $state(false);
	let pauseRequestedAt = 0;
	/**
	 * A pause that was asked for and never landed. Kept separate from lastError
	 * because a successful poll clears that one every 2s, and this needs to stay
	 * up until the operator does something about it.
	 */
	let pauseWarning = $state<string | null>(null);
	let pollHandle: ReturnType<typeof setTimeout> | null = null;
	let destroyed = false;

	const TERMINAL = new Set(['succeeded', 'failed', 'stopped']);
	// Every hop in the bridge chain budgets 30s for one round trip: the daemon's
	// RELAY_TIMEOUT_S, bridgeFetch's BRIDGE_TIMEOUT_MS, and the endpoint's
	// maxDuration of 45s. The browser used to give up at 6s, which is shorter than
	// a normal round trip rather than longer, so it reported a timeout for requests
	// that were still perfectly on track.
	const POLL_TIMEOUT_MS = 20_000;
	const ACTION_TIMEOUT_MS = 30_000;
	/**
	 * The bridge is a serialized queue — one command per robot at a time. A status
	 * GET issued while the daemon is mid-scan or mid-upload waits its turn, which
	 * is normal operation, not a fault. Only sustained failure is worth showing,
	 * so a lone slow poll no longer paints a red banner over a healthy run.
	 */
	const POLL_FAILURES_BEFORE_WARNING = 3;
	/**
	 * Auto-resume exists for exactly one thing: the engine's off-deck "confirm deck
	 * loaded" pause at the very start of a run. Bound it to the run's own age
	 * rather than to how long this component has been mounted, so that reloading
	 * the page mid-run cannot re-arm it against a pause the operator made earlier.
	 * The daemon gives up watching at AUTO_RESUME_TIMEOUT_S (75s); allow headroom.
	 */
	const AUTO_RESUME_WINDOW_MS = 90_000;
	/**
	 * How long a requested pause may sit unacknowledged before we stop claiming it
	 * is on its way. The OT-2 pauses at the next command boundary, and a fill's
	 * longest single step is an aspirate-and-dispense batch, so this is generous.
	 * Past it, say so and re-enable the button rather than leaving the operator
	 * staring at a disabled control.
	 */
	const PAUSE_LAND_TIMEOUT_MS = 60_000;

	/**
	 * Is this run still young enough that a pause could plausibly be the initial
	 * off-deck one? Measured from the run's own startedAt, so it survives reloads.
	 * A run with no startedAt yet has not begun, so it is trivially within.
	 */
	function withinAutoResumeWindow(): boolean {
		const startedAt = run?.startedAt ? new Date(run.startedAt).getTime() : null;
		if (!startedAt || Number.isNaN(startedAt)) return true;
		return Date.now() - startedAt < AUTO_RESUME_WINDOW_MS;
	}

	function schedulePoll() {
		if (!destroyed) pollHandle = setTimeout(poll, pollMs);
	}
	// Force an immediate reconcile poll (e.g. right after a control action) rather
	// than waiting for the next tick.
	function pollNow() {
		if (pollHandle) { clearTimeout(pollHandle); pollHandle = null; }
		void poll();
	}

	async function poll() {
		// Don't fight an in-flight control action for the serialized bridge queue,
		// and never overwrite the optimistic status with an older reading.
		if (actionInFlight) { schedulePoll(); return; }
		try {
			const res = await fetch(`/api/opentrons-lab/robots/${robotId}/runs/${opentronsRunId}`, {
				signal: AbortSignal.timeout(POLL_TIMEOUT_MS)
			});
			if (res.ok) {
				const body = await res.json();
				run = body.data ?? body;
				// A control action may have started during the await — don't clobber it.
				if (!actionInFlight) {
					const next = (run.status ?? 'idle') as string;
					runStatus = next;
					lastError = null;
					pollError = null;
					pollFailures = 0;

					if (!terminalFired && TERMINAL.has(next)) {
						terminalFired = true;
						if (onComplete) onComplete(next, run);
					}

					if (next === 'paused') {
						// The robot has actually settled into the pause.
						pausePending = false;
						pauseWarning = null;
						// Off-deck labware makes the engine pause once at the very start;
						// auto-resume only THAT pause. Never one the operator asked for,
						// never one late in the run, never error-recovery.
						if (!autoResumedInitial && !operatorPaused && withinAutoResumeWindow()) {
							autoResumedInitial = true;
							void handleAction('resume');
						}
					} else if (TERMINAL.has(next)) {
						pausePending = false;
					} else if (pausePending && Date.now() - pauseRequestedAt > PAUSE_LAND_TIMEOUT_MS) {
						// Requested a pause, but the robot is still going well past the
						// point where it should have hit a command boundary. Stop implying
						// the pause is imminent and let them act on it.
						pausePending = false;
						pauseWarning =
							'The robot has not acknowledged the pause and is still running — '
							+ 'try Pause again, or use Stop if it needs to come down now.';
					}
				}
			} else {
				pollFailures += 1;
				pollError = `Robot returned ${res.status}`;
			}
		} catch (err) {
			pollFailures += 1;
			pollError = (err as any)?.name === 'TimeoutError'
				? `Robot status has not answered for ${pollFailures} checks — the bridge may be busy or down`
				: err instanceof Error ? err.message : 'Failed to reach robot';
		}
		// Keep polling even after terminal so the operator sees the final state.
		schedulePoll();
	}

	async function handleAction(action: 'play' | 'pause' | 'stop' | 'resume') {
		actionInFlight = action;
		// Any fresh action supersedes a stale "pause never landed" complaint.
		pauseWarning = null;
		// Record what the operator wants BEFORE the request, so a poll that lands
		// mid-flight can't auto-resume a pause they just asked for.
		if (action === 'pause') {
			operatorPaused = true;
			pausePending = true;
			pauseRequestedAt = Date.now();
			// Whatever the initial off-deck pause did or didn't do, it is settled as
			// far as this run is concerned — never auto-resume after a manual pause.
			autoResumedInitial = true;
		} else if (action === 'play' || action === 'resume') {
			operatorPaused = false;
			pausePending = false;
		} else if (action === 'stop') {
			pausePending = false;
		}

		// Optimistic UI: flip the visible status immediately. Polls won't overwrite
		// it while actionInFlight is set, so it won't flicker back.
		if (action === 'play' || action === 'resume') runStatus = 'running';
		else if (action === 'pause') runStatus = 'pause-requested';
		else if (action === 'stop') runStatus = 'stop-requested';

		try {
			const res = await fetch(
				`/api/opentrons-lab/robots/${robotId}/runs/${opentronsRunId}/actions`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ action }),
					signal: AbortSignal.timeout(ACTION_TIMEOUT_MS)
				}
			);
			const body = await res.json().catch(() => ({}));
			if (res.ok) {
				lastError = null;
			} else if ((body as any).conflict) {
				// Action was invalid for the robot's CURRENT state (e.g. Pause when
				// already paused) — benign; the reconcile poll below syncs the UI.
				lastError = null;
			} else {
				lastError = (body as any).detail ?? (body as any).message ?? `Robot returned ${res.status}`;
				// The robot definitively refused. Don't leave the UI claiming a pause
				// is coming when none is — re-enable the button so it can be retried.
				// (A timeout is NOT handled here: the request may still have landed,
				// so that case falls through to the reconcile poll.)
				if (action === 'pause') {
					pausePending = false;
					operatorPaused = false;
				}
			}
		} catch (err) {
			lastError = (err as any)?.name === 'TimeoutError'
				? 'Action timed out (bridge slow) — re-checking status'
				: err instanceof Error ? err.message : 'Action failed';
		} finally {
			actionInFlight = null;
			pollNow(); // reconcile to the robot's true state right away
		}
	}

	function statusColor(s: string): string {
		switch (s) {
			case 'running':
				return 'bg-green-900/40 text-green-300 border-green-500/40';
			case 'paused':
			case 'pause-requested':
				return 'bg-yellow-900/40 text-yellow-300 border-yellow-500/40';
			case 'succeeded':
				return 'bg-cyan-900/40 text-cyan-300 border-cyan-500/40';
			case 'failed':
				return 'bg-red-900/40 text-red-300 border-red-500/40';
			case 'stopped':
			case 'stop-requested':
				return 'bg-gray-800 text-gray-300 border-gray-500/40';
			case 'finishing':
				return 'bg-green-900/40 text-green-300 border-green-500/40';
			case 'blocked-by-open-door':
			case 'awaiting-recovery':
				return 'bg-orange-900/40 text-orange-300 border-orange-500/40';
			case 'idle':
				return 'bg-blue-900/40 text-blue-300 border-blue-500/40';
			default:
				return 'bg-black/40 text-[var(--color-tron-text-secondary)] border-[var(--color-tron-border)]';
		}
	}

	// Pull the human-readable current command — Opentrons HTTP API exposes
	// the protocol's last-issued command in run.currentRunCommands or
	// run.commands depending on version; we just show whatever's last.
	let currentCommand = $derived.by(() => {
		const cmds = run?.actions ?? [];
		if (Array.isArray(cmds) && cmds.length > 0) {
			const last = cmds[cmds.length - 1];
			return last?.actionType ?? null;
		}
		return null;
	});

	let elapsed = $derived.by(() => {
		if (!run?.startedAt) return null;
		const start = new Date(run.startedAt).getTime();
		const end = run.completedAt ? new Date(run.completedAt).getTime() : Date.now();
		const sec = Math.round((end - start) / 1000);
		const m = Math.floor(sec / 60);
		const s = sec % 60;
		return `${m}m ${s.toString().padStart(2, '0')}s`;
	});

	// Boot: start polling. onDestroy clears the timer.
	$effect(() => {
		if (!pollHandle) poll();
	});

	onDestroy(() => {
		destroyed = true;
		if (pollHandle) {
			clearTimeout(pollHandle);
			pollHandle = null;
		}
	});

	// An action the operator pressed reports straight away — they are waiting on it.
	// A background poll only earns the banner once it has failed repeatedly.
	let visibleError = $derived(
		lastError ?? pauseWarning ?? (pollFailures >= POLL_FAILURES_BEFORE_WARNING ? pollError : null)
	);

	let isTerminal = $derived(TERMINAL.has(runStatus));

	/**
	 * What the operator sees. While a pause is pending the robot still reports
	 * `running` until it finishes the command in flight, and the reconcile poll
	 * would otherwise flip the chip straight back to RUNNING — which reads as
	 * "the button did nothing". Keep saying PAUSE-REQUESTED until it lands.
	 */
	let displayStatus = $derived(
		pausePending && !isTerminal && runStatus !== 'paused' ? 'pause-requested' : runStatus
	);

	// Stop must always be available while the run is live (any non-terminal state,
	// incl. finishing / blocked-by-open-door / awaiting-recovery).
	let canStop = $derived(!isTerminal);
	let canPause = $derived(runStatus === 'running' && !pausePending);
	// Play/Resume: any live, non-running, non-transitioning state.
	let canPlay = $derived(
		!isTerminal && displayStatus !== 'running' && displayStatus !== 'pause-requested' && displayStatus !== 'stop-requested'
	);
</script>

<div class="space-y-4 rounded-xl border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
	<div class="flex items-baseline justify-between">
		<h3 class="text-lg font-semibold text-[var(--color-tron-text)]">Running on {robotName}</h3>
		<span
			class="rounded-full border px-3 py-1 text-xs font-medium uppercase tracking-wider {statusColor(
				displayStatus
			)}"
		>
			{displayStatus}
		</span>
	</div>

	{#if pausePending && !isTerminal && runStatus !== 'paused'}
		<div class="rounded border border-yellow-500/40 bg-yellow-900/10 p-2 text-xs text-yellow-300">
			Pause requested — the robot finishes the step it is already on before it stops,
			so this can take a few seconds on a fill.
		</div>
	{/if}

	{#if visibleError}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-2 text-xs text-red-300">
			{visibleError}
		</div>
	{/if}

	<div class="grid grid-cols-2 gap-3 text-xs">
		<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-2">
			<div class="uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
				OT-2 run id
			</div>
			<div class="mt-1 font-mono break-all" style="color: var(--color-tron-text)">
				{opentronsRunId}
			</div>
		</div>
		<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-2">
			<div class="uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
				Elapsed
			</div>
			<div class="mt-1 font-mono" style="color: var(--color-tron-text)">
				{elapsed ?? '—'}
			</div>
		</div>
	</div>

	{#if currentCommand}
		<div class="rounded border border-[var(--color-tron-border)] bg-black/20 p-2 text-xs">
			<span class="uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
				Last action:
			</span>
			<span class="ml-2 font-mono" style="color: var(--color-tron-text)">{currentCommand}</span>
		</div>
	{/if}

	<div class="flex flex-wrap gap-2">
		<button
			type="button"
			onclick={() => handleAction('play')}
			disabled={!canPlay || !!actionInFlight}
			class="flex-1 rounded border border-green-500/50 bg-green-900/20 px-4 py-2 text-sm font-medium text-green-300 transition-colors hover:bg-green-900/40 disabled:cursor-not-allowed disabled:opacity-30"
		>
			▶ {displayStatus === 'paused' ? 'Resume' : 'Play'}
		</button>
		<button
			type="button"
			onclick={() => handleAction('pause')}
			disabled={!canPause || !!actionInFlight}
			class="flex-1 rounded border border-yellow-500/50 bg-yellow-900/20 px-4 py-2 text-sm font-medium text-yellow-300 transition-colors hover:bg-yellow-900/40 disabled:cursor-not-allowed disabled:opacity-30"
		>
			⏸ Pause
		</button>
		<button
			type="button"
			onclick={() => {
				if (confirm('Stop this run? This cannot be undone.')) handleAction('stop');
			}}
			disabled={!canStop || !!actionInFlight}
			class="flex-1 rounded border border-red-500/50 bg-red-900/20 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-900/40 disabled:cursor-not-allowed disabled:opacity-30"
		>
			■ Stop
		</button>
	</div>

	{#if TERMINAL.has(runStatus)}
		<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-2 text-xs" style="color: var(--color-tron-text-secondary)">
			Run finished with status <span class="font-mono" style="color: var(--color-tron-cyan)">{runStatus}</span>.
			Advancing the flow…
		</div>
		{#if runStatus === 'failed' && run?.errors?.length}
			<div class="mt-2 rounded border border-red-500/40 bg-red-900/15 p-2 text-xs text-red-300">
				<p class="font-semibold">Why it failed</p>
				<ul class="mt-1 space-y-1">
					{#each run.errors as e (e.id ?? e.detail ?? e.errorType)}
						<li class="font-mono text-[11px] leading-snug text-red-200/90">{e.detail ?? e.errorType ?? 'Unknown error'}</li>
					{/each}
				</ul>
				{#if run.errors.some((e: any) => /labware/i.test(e.detail ?? '') && /not found/i.test(e.detail ?? ''))}
					<p class="mt-1 text-[10px] text-red-300/70">A custom labware definition isn't on this robot — re-upload the protocol bundled with its labware (the Opentrons app does this automatically; the cloud import does not).</p>
				{/if}
			</div>
		{/if}
	{/if}
</div>
