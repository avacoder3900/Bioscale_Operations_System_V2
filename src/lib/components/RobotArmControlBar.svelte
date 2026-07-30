<script lang="ts">
	// ARM-01 §8.4 — who holds the arm, plus an always-live Stop.
	//
	// Because control can come from any device (G0), the holder may be someone
	// else on another machine. Stop is deliberately enabled regardless of who
	// holds the arm: a stop that respects the lock is a stop that fails when you
	// need it most. Stopping someone else's run asks for confirmation first.
	//
	// This bar is the SINGLE session indicator for the arm. It previously shared
	// that job with an inline banner on the control page, which could disagree
	// with it; that banner is gone and its two extra states (unreachable, and the
	// Pi's live `active` session) were folded in here.
	import { enhance } from '$app/forms';

	interface Holder {
		runId: string;
		type: string;
		username: string | null;
		userId: string | null;
		since: string | null;
		stale: boolean;
	}

	interface ActiveSession {
		run_id: string;
		kind: string;
	}

	let {
		holder = null,
		active = null,
		connectError = null,
		currentUserId = null,
		stopAction = '?/stop'
	}: {
		holder?: Holder | null;
		active?: ActiveSession | null;
		connectError?: string | null;
		currentUserId?: string | null;
		stopAction?: string;
	} = $props();

	let stopping = $state(false);

	// `active` is live from the Pi; `holder` is derived from Mongo robot_arm_runs.
	// They are different sources and CAN disagree — a run whose terminal webhook
	// never landed leaves a holder row set forever while the Pi reports nothing
	// running. So: the Pi is the authority on liveness, Mongo on attribution.
	//
	// Don't name this `state` — `$state` would then parse as a store subscription
	// rather than the rune.
	const barState = $derived(
		connectError ? 'unreachable' : active ? 'running' : holder ? 'orphaned' : 'idle'
	);

	const dotColor = $derived(
		barState === 'running'
			? '#38bdf8'
			: barState === 'orphaned'
				? '#f59e0b'
				: barState === 'unreachable'
					? '#ef4444'
					: 'var(--color-tron-text-secondary)'
	);

	const borderColor = $derived(
		barState === 'running'
			? 'var(--color-tron-accent, #38bdf8)'
			: barState === 'orphaned'
				? '#f59e0b'
				: barState === 'unreachable'
					? '#ef4444'
					: 'var(--color-tron-border)'
	);

	// Stop can only do something when the Pi is reachable AND actually running
	// something. On an orphaned row the Pi has nothing to stop, but we still offer
	// it because the row may reflect a run the Pi is unaware of.
	const canStop = $derived(barState === 'running' || barState === 'orphaned');

	// Elapsed time is rendered from `since` on each render rather than ticking —
	// this bar is not a live clock, and a per-second interval on every arm page
	// would be noise for no operational value.
	function elapsed(since: string | null): string {
		if (!since) return '';
		const ms = Date.now() - new Date(since).getTime();
		if (ms < 0) return '';
		const secs = Math.floor(ms / 1000);
		const mins = Math.floor(secs / 60);
		const hrs = Math.floor(mins / 60);
		const days = Math.floor(hrs / 24);
		if (days > 0) return `${days}d ${hrs % 24}h`;
		if (hrs > 0) return `${hrs}h ${mins % 60}m`;
		if (mins > 0) return `${mins}m ${secs % 60}s`;
		return `${secs}s`;
	}

	function confirmStop(event: SubmitEvent) {
		// Only interrupt when the run belongs to somebody else. Confirming on your
		// own run is friction with no safety value.
		const someoneElse =
			holder?.username != null && holder.userId != null && holder.userId !== currentUserId;
		if (someoneElse) {
			const ok = window.confirm(`${holder?.username} started this run. Stop it anyway?`);
			if (!ok) {
				event.preventDefault();
				return false;
			}
		}
		return true;
	}
</script>

<!--
	Sticky to the bottom of the viewport on phones so Stop is always within
	thumb reach; inline on desktop.
-->
<div
	class="sticky bottom-0 z-20 -mx-3 border-t px-3 py-2 sm:relative sm:bottom-auto sm:mx-0 sm:rounded sm:border sm:px-4"
	style="border-color: {borderColor}; background: var(--color-tron-surface);"
>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div class="flex min-w-0 items-center gap-2">
			<span
				class="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
				style="background: {dotColor}"
			></span>

			{#if barState === 'unreachable'}
				<span class="min-w-0 truncate text-xs sm:text-sm" style="color: var(--color-tron-text)">
					<span class="font-semibold" style="color: #ef4444">UNREACHABLE</span>
					<span style="color: var(--color-tron-text-secondary)">· cannot reach the arm</span>
				</span>
			{:else if barState === 'running'}
				<span class="min-w-0 truncate text-xs sm:text-sm" style="color: var(--color-tron-text)">
					<span class="font-semibold">RUNNING</span>
					<span style="color: var(--color-tron-text-secondary)">
						{active?.kind}
						{#if holder?.username}· held by {holder.username}{/if}
						{#if holder?.since}· {elapsed(holder.since)}{/if}
					</span>
				</span>
			{:else if barState === 'orphaned'}
				<span class="min-w-0 truncate text-xs sm:text-sm" style="color: var(--color-tron-text)">
					<span class="font-semibold" style="color: #f59e0b">STALE</span>
					<span style="color: var(--color-tron-text-secondary)">
						{holder?.type}
						{#if holder?.username}· held by {holder.username}{/if}
						{#if holder?.since}· {elapsed(holder.since)}{/if}
					</span>
				</span>
			{:else}
				<span class="text-xs sm:text-sm" style="color: var(--color-tron-text-secondary)">
					IDLE — arm is free
				</span>
			{/if}
		</div>

		{#if canStop}
			<form
				method="POST"
				action={stopAction}
				onsubmit={confirmStop}
				use:enhance={() => {
					stopping = true;
					return async ({ update }) => {
						await update();
						stopping = false;
					};
				}}
			>
				<button
					type="submit"
					disabled={stopping}
					class="min-h-[44px] rounded px-4 text-sm font-semibold disabled:opacity-50"
					style="background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid #ef4444;"
				>
					{stopping ? 'Stopping…' : '■ STOP'}
				</button>
			</form>
		{/if}
	</div>

	{#if barState === 'unreachable'}
		<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
			{connectError}
		</p>
	{/if}

	{#if barState === 'orphaned'}
		<p class="mt-1 text-xs" style="color: #f59e0b">
			The arm reports nothing running, but this run was never closed out — its terminal event
			never arrived. It will keep blocking Run Task until it is resolved.
		</p>
	{/if}
</div>
