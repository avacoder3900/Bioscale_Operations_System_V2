<script lang="ts">
	/**
	 * Teleop recording on the Teach tab, under the conveyor belt (moved from
	 * Maintenance › Leader Arm, Alejandro 2026-11-04): record the follower
	 * while the operator drives the leader arm, stop it, then import the
	 * recording as poses / a move set (the clean-up page).
	 *
	 * The forms post to the Leader Arm page's own actions (startRecord, stop);
	 * use:enhance applies the result to this page's `form` and reloads it.
	 */
	import { enhance } from '$app/forms';

	let {
		active = null,
		armReachable = false
	}: {
		/** The session holding the arm right now, if any (teleop / record / replay). */
		active?: { kind: string } | null;
		armReachable?: boolean;
	} = $props();

	const CONTROL = '/manufacturing/cart-mfg/robot-arm/maintenance/control';
	const input = 'mt-1 w-full rounded border bg-black/40 px-2 py-1 text-sm';
	const inputStyle = 'border-color: var(--color-tron-border); color: var(--color-tron-text)';
	const muted = 'color: var(--color-tron-text-secondary)';

	const recording = $derived(active?.kind === 'record');
</script>

<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
	<div class="flex items-center justify-between gap-2">
		<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">Teleop Recording</h2>
		<a href="/manufacturing/cart-mfg/robot-arm/maintenance/cleanup" class="text-xs underline" style="color: var(--color-tron-cyan)">Import Recording</a>
	</div>

	{#if recording}
		<form method="POST" action="{CONTROL}?/stop" use:enhance class="mt-2 flex items-center justify-between gap-2 text-xs">
			<span class="font-semibold" style="color: #fbbf24">● Recording</span>
			<button type="submit" class="rounded border px-3 py-1 text-xs font-medium" style="border-color: #ef4444; color: #fca5a5">■ Stop Recording</button>
		</form>
	{:else}
		<form method="POST" action="{CONTROL}?/startRecord" use:enhance class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_5rem_6.5rem_auto] sm:items-end">
			<label class="block text-xs" style={muted}>
				Name
				<input type="text" name="name" required maxlength="80" placeholder="e.g. movementtest1" class={input} style={inputStyle} />
			</label>
			<label class="block text-xs" style={muted}>
				Rate (Hz)
				<input type="number" name="rate_hz" value="30" min="1" max="60" class={input} style={inputStyle} />
			</label>
			<label class="block text-xs" style={muted}>
				Duration (s)
				<input type="number" name="duration_s" placeholder="Until Stopped" min="1" class={input} style={inputStyle} />
			</label>
			<button
				type="submit"
				disabled={!!active || !armReachable}
				title={!armReachable ? 'The arm is unreachable' : active ? 'Another session holds the arm' : 'Record the follower while you drive the leader arm'}
				class="rounded border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/10 disabled:cursor-not-allowed disabled:opacity-40"
				style="border-color: var(--color-tron-cyan); color: var(--color-tron-cyan)">● Start Recording</button
			>
		</form>
	{/if}
</section>
