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
		pollMs = 2000,
		serviceEnabled = false
	} = $props<{
		robotId: string;
		robotName?: string;
		opentronsRunId: string;
		onComplete?: (status: string, run: any) => void;
		pollMs?: number;
		/** Show the in-run service panel (WAX-SERVICE-1). Only the wax fill
		 *  protocol implements the in-protocol service loop, so this stays off
		 *  for reagent until that protocol gets the same treatment. */
		serviceEnabled?: boolean;
	}>();

	let run = $state<any>(null);
	let runStatus = $state<string>('idle');
	let lastError = $state<string | null>(null);
	let actionInFlight = $state<string | null>(null);
	let terminalFired = $state(false);
	// Auto-resume the initial "confirm off-deck labware" pause so operators don't
	// click resume at the start of the wax/reagent protocol. Fires once.
	let autoResumedInitial = $state(false);
	let pollHandle: ReturnType<typeof setTimeout> | null = null;
	let destroyed = false;

	const TERMINAL = new Set(['succeeded', 'failed', 'stopped']);
	const POLL_TIMEOUT_MS = 6000;
	const ACTION_TIMEOUT_MS = 12000;

	// ---- In-run service session (WAX-SERVICE-1) ---------------------------
	// This is NOT the engine's Pause. A paused engine stops executing the
	// protocol, so the in-protocol service loop could neither move the gantry
	// nor poll — it would deadlock. The fill keeps running; it just parks
	// itself between wells and takes commands.
	let session = $state<any>(null);
	let serviceBusy = $state<string | null>(null);
	let serviceError = $state<string | null>(null);
	let jogStep = $state(1);
	const JOG_STEPS = [0.1, 0.5, 1, 5];
	const SERVICE_URL = $derived(
		`/api/opentrons-lab/robots/${robotId}/runs/${opentronsRunId}/service`
	);
	let serviceOpen = $derived(!!session);
	let serviceParked = $derived(session?.status === 'active');
	let servicePending = $derived(session?.pendingCommand?.id ?? null);

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
					if (!terminalFired && TERMINAL.has(next)) {
						terminalFired = true;
						// The run is over, so nothing is left to park — don't leave a
						// session hanging open against a dead run.
						if (serviceEnabled && session) void toggleService('close');
						if (onComplete) onComplete(next, run);
					}
					// Off-deck labware makes the engine pause once at the very start;
					// auto-resume it (only the first pause, never error-recovery).
					// Never fire while a service session is open — the operator is
					// deliberately parked and auto-resuming would fight them.
					else if (!autoResumedInitial && next === 'paused' && !serviceOpen) {
						autoResumedInitial = true;
						void handleAction('resume');
					}
				}
			} else {
				lastError = `Robot returned ${res.status}`;
			}
		} catch (err) {
			lastError = (err as any)?.name === 'TimeoutError'
				? 'Robot status timed out (bridge slow) — retrying'
				: err instanceof Error ? err.message : 'Failed to reach robot';
		}
		if (serviceEnabled) await refreshSession();
		// Keep polling even after terminal so the operator sees the final state.
		schedulePoll();
	}

	async function handleAction(action: 'play' | 'pause' | 'stop' | 'resume') {
		actionInFlight = action;
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

	async function refreshSession() {
		try {
			const res = await fetch(SERVICE_URL, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
			if (res.ok) session = (await res.json()).session ?? null;
		} catch {
			// A failed session poll is not worth a banner — the next tick retries.
		}
	}

	/** Ask the fill to park itself at the next well, or abandon the request. */
	async function toggleService(action: 'open' | 'close') {
		serviceBusy = action;
		serviceError = null;
		try {
			const res = await fetch(SERVICE_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action }),
				signal: AbortSignal.timeout(ACTION_TIMEOUT_MS)
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) serviceError = (body as any).message ?? `Request failed (${res.status})`;
			else session = (body as any).session ?? null;
		} catch (err) {
			serviceError = err instanceof Error ? err.message : 'Request failed';
		} finally {
			serviceBusy = null;
			void refreshSession();
		}
	}

	/** Queue one verb for the parked protocol. Only one runs at a time. */
	async function serviceCommand(verb: string, args: Record<string, unknown> = {}) {
		serviceBusy = verb;
		serviceError = null;
		try {
			const res = await fetch(`${SERVICE_URL}/command`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ verb, args }),
				signal: AbortSignal.timeout(ACTION_TIMEOUT_MS)
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) serviceError = (body as any).message ?? `Command failed (${res.status})`;
		} catch (err) {
			serviceError = err instanceof Error ? err.message : 'Command failed';
		} finally {
			serviceBusy = null;
			void refreshSession();
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

	let isTerminal = $derived(TERMINAL.has(runStatus));
	// Stop must always be available while the run is live (any non-terminal state,
	// incl. finishing / blocked-by-open-door / awaiting-recovery).
	let canStop = $derived(!isTerminal);
	let canPause = $derived(runStatus === 'running');
	// Play/Resume: any live, non-running, non-transitioning state.
	let canPlay = $derived(
		!isTerminal && runStatus !== 'running' && runStatus !== 'pause-requested' && runStatus !== 'stop-requested'
	);
</script>

<div class="space-y-4 rounded-xl border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
	<div class="flex items-baseline justify-between">
		<h3 class="text-lg font-semibold text-[var(--color-tron-text)]">Running on {robotName}</h3>
		<span
			class="rounded-full border px-3 py-1 text-xs font-medium uppercase tracking-wider {statusColor(
				runStatus
			)}"
		>
			{runStatus}
		</span>
	</div>

	{#if lastError}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-2 text-xs text-red-300">
			{lastError}
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

	{#if serviceEnabled && session?.location?.wellName}
		<div class="rounded border border-[var(--color-tron-border)] bg-black/20 p-2 text-xs">
			<span class="uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
				Last hole:
			</span>
			<span class="ml-2 font-mono" style="color: var(--color-tron-text)">
				{session.location.wellName}
				{#if session.location.volumeUl != null}· {session.location.volumeUl}µL{/if}
				{#if session.location.tipNumber != null}· dispense #{session.location.tipNumber}{/if}
			</span>
		</div>
	{:else if currentCommand}
		<div class="rounded border border-[var(--color-tron-border)] bg-black/20 p-2 text-xs">
			<span class="uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
				Last action:
			</span>
			<span class="ml-2 font-mono" style="color: var(--color-tron-text)">{currentCommand}</span>
		</div>
	{/if}

	{#if serviceEnabled && serviceOpen}
		<div class="space-y-3 rounded-lg border border-orange-500/50 bg-orange-900/10 p-3">
			<div class="flex items-baseline justify-between">
				<h4 class="text-sm font-semibold text-orange-300">Calibrate mid-run</h4>
				<span class="font-mono text-[11px] text-orange-300/80">
					{serviceParked ? `parked at ${session?.location?.wellName ?? '—'}` : 'waiting for the fill to reach the next hole…'}
				</span>
			</div>

			{#if serviceError}
				<div class="rounded border border-red-500/40 bg-red-900/10 p-2 text-xs text-red-300">{serviceError}</div>
			{/if}
			{#if session?.lastResult?.detail}
				<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-2 font-mono text-[11px]"
					style="color: var(--color-tron-text-secondary)">
					{session.lastResult.ok === false ? '✗' : '✓'} {session.lastResult.detail}
				</div>
			{/if}

			{#if serviceParked}
				<div class="flex items-center gap-2 text-xs">
					<span style="color: var(--color-tron-text-secondary)">Step</span>
					{#each JOG_STEPS as step (step)}
						<button type="button" onclick={() => { jogStep = step; }}
							class="rounded border px-2 py-0.5 font-mono {jogStep === step
								? 'border-orange-400 bg-orange-900/40 text-orange-200'
								: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}"
						>{step}mm</button>
					{/each}
				</div>

				<div class="grid grid-cols-3 gap-2 text-sm">
					{#each [['x', 'X'], ['y', 'Y'], ['z', 'Z']] as [axis, label] (axis)}
						<div class="flex items-center gap-1">
							<button type="button" disabled={!!serviceBusy || !!servicePending}
								onclick={() => serviceCommand('jog', { axis, mm: -jogStep })}
								class="flex-1 rounded border border-[var(--color-tron-border)] py-1 font-mono disabled:opacity-30"
								style="color: var(--color-tron-text)">−{label}</button>
							<button type="button" disabled={!!serviceBusy || !!servicePending}
								onclick={() => serviceCommand('jog', { axis, mm: jogStep })}
								class="flex-1 rounded border border-[var(--color-tron-border)] py-1 font-mono disabled:opacity-30"
								style="color: var(--color-tron-text)">+{label}</button>
						</div>
					{/each}
				</div>

				<div class="flex flex-wrap gap-2 text-xs">
					<button type="button" disabled={!!serviceBusy || !!servicePending}
						onclick={() => serviceCommand('goto_well')}
						class="flex-1 rounded border border-[var(--color-tron-border)] px-3 py-2 disabled:opacity-30"
						style="color: var(--color-tron-text)">↩ Return to hole</button>
					<button type="button" disabled={!!serviceBusy || !!servicePending}
						onclick={() => serviceCommand('tip_cal')}
						class="flex-1 rounded border border-[var(--color-tron-border)] px-3 py-2 disabled:opacity-30"
						style="color: var(--color-tron-text)">◎ Calibrate tip</button>
					<button type="button" disabled={!!serviceBusy || !!servicePending}
						onclick={() => serviceCommand('change_tip')}
						class="flex-1 rounded border border-[var(--color-tron-border)] px-3 py-2 disabled:opacity-30"
						style="color: var(--color-tron-text)">⟲ New tip + calibrate</button>
				</div>

				<p class="text-[11px] leading-snug" style="color: var(--color-tron-text-secondary)">
					Jogging is for checking alignment only — the offset is discarded on resume.
					Only a tip calibration changes what the fill uses. Emptying the tip re-aspirates
					for the rest of the batch automatically.
				</p>
			{/if}

			<div class="flex gap-2">
				<button type="button" disabled={!!serviceBusy || !serviceParked || !!servicePending}
					onclick={() => serviceCommand('resume')}
					class="flex-1 rounded border border-green-500/50 bg-green-900/20 px-4 py-2 text-sm font-medium text-green-300 disabled:opacity-30"
				>▶ Resume fill</button>
				<button type="button" disabled={!!serviceBusy}
					onclick={() => toggleService('close')}
					class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-sm disabled:opacity-30"
					style="color: var(--color-tron-text-secondary)"
				>Cancel</button>
			</div>
		</div>
	{/if}

	<div class="flex flex-wrap gap-2">
		<button
			type="button"
			onclick={() => handleAction('play')}
			disabled={!canPlay || !!actionInFlight}
			class="flex-1 rounded border border-green-500/50 bg-green-900/20 px-4 py-2 text-sm font-medium text-green-300 transition-colors hover:bg-green-900/40 disabled:cursor-not-allowed disabled:opacity-30"
		>
			▶ {runStatus === 'paused' ? 'Resume' : 'Play'}
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
		{#if serviceEnabled && !serviceOpen && runStatus === 'running'}
			<!-- Deliberately NOT the engine's Pause: the fill keeps running and
			     parks itself between holes, which is what lets it resume on the
			     exact well it stopped at. -->
			<button
				type="button"
				onclick={() => toggleService('open')}
				disabled={!!serviceBusy}
				class="flex-1 rounded border border-orange-500/50 bg-orange-900/20 px-4 py-2 text-sm font-medium text-orange-300 transition-colors hover:bg-orange-900/40 disabled:cursor-not-allowed disabled:opacity-30"
			>
				⚙ Pause &amp; Calibrate
			</button>
		{/if}
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
