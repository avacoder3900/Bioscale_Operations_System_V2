<script lang="ts">
	// ARM-01 §8.4 — who holds the arm, plus an always-live Stop.
	//
	// Because control can come from any device (G0), the holder may be someone
	// else on another machine. Stop is deliberately enabled regardless of who
	// holds the arm: a stop that respects the lock is a stop that fails when you
	// need it most. Stopping someone else's run asks for confirmation first.
	import { enhance } from '$app/forms';

	interface Holder {
		runId: string;
		type: string;
		username: string | null;
		since: string | null;
		stale: boolean;
	}

	let {
		holder = null,
		currentUserId = null,
		stopAction = '?/stop'
	}: {
		holder?: Holder | null;
		currentUserId?: string | null;
		stopAction?: string;
	} = $props();

	let stopping = $state(false);

	const held = $derived(holder !== null);

	// Elapsed time is rendered from `since` on each render rather than ticking —
	// this bar is not a live clock, and a per-second interval on every arm page
	// would be noise for no operational value.
	function elapsed(since: string | null): string {
		if (!since) return '';
		const ms = Date.now() - new Date(since).getTime();
		if (ms < 0) return '';
		const mins = Math.floor(ms / 60000);
		const secs = Math.floor((ms % 60000) / 1000);
		return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
	}

	function confirmStop(event: SubmitEvent) {
		if (held && holder?.username) {
			const ok = window.confirm(
				`${holder.username} started this run. Stop it anyway?`
			);
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
	style="border-color: {held && holder?.stale
		? '#f59e0b'
		: held
			? 'var(--color-tron-accent, #38bdf8)'
			: 'var(--color-tron-border)'}; background: var(--color-tron-surface);"
>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div class="flex min-w-0 items-center gap-2">
			{#if held}
				<span
					class="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
					style="background: {holder?.stale ? '#f59e0b' : '#38bdf8'}"
				></span>
				<span class="min-w-0 truncate text-xs sm:text-sm" style="color: var(--color-tron-text)">
					<span class="font-semibold">{holder?.stale ? 'STALE' : 'RUNNING'}</span>
					<span style="color: var(--color-tron-text-secondary)">
						{holder?.type}
						{#if holder?.username}· held by {holder.username}{/if}
						{#if holder?.since}· {elapsed(holder.since)}{/if}
					</span>
				</span>
			{:else}
				<span
					class="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
					style="background: var(--color-tron-text-secondary)"
				></span>
				<span class="text-xs sm:text-sm" style="color: var(--color-tron-text-secondary)">
					IDLE — arm is free
				</span>
			{/if}
		</div>

		{#if held}
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

	{#if held && holder?.stale}
		<p class="mt-1 text-xs" style="color: #f59e0b">
			This run has been open a long time with no terminal event — it may have been abandoned.
		</p>
	{/if}
</div>
