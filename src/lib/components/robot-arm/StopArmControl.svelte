<script lang="ts">
	/**
	 * "Stop arm" on the status card, on every Robot Arm tab: the one halt for
	 * whatever the arm itself is doing (a play, a replay, teleop, a Return to
	 * home attempt). Torque is turned back on so the arm holds where it is.
	 * It does not touch the OT-2 — the Run tab's STOP RUN is the whole-line
	 * halt — and the confirm text says so.
	 */
	import { announceBusFree } from '$lib/robot-arm/bus-free';

	interface Props {
		armReachable: boolean;
	}
	let { armReachable }: Props = $props();

	let busy = $state(false);
	let note = $state<{ ok: boolean; text: string } | null>(null);

	const CONFIRM =
		'Stop the arm now?\n\n' +
		'• Whatever the arm is playing stops where it is (any play, replay, teleop or Return to home attempt).\n' +
		'• Torque stays on, so the arm holds its position.\n' +
		'• The OT-2 is NOT touched. For the whole wax-fill line, use STOP RUN on the Run tab.';

	async function stop() {
		if (busy || !confirm(CONFIRM)) return;
		busy = true;
		note = null;
		try {
			const res = await fetch('/api/robot-arm/stop', { method: 'POST', credentials: 'same-origin' });
			const body = await res.json().catch(() => ({}));
			if (res.ok && body.ok) note = { ok: !!body.torqueOn, text: String(body.message ?? 'Stopped.') };
			else note = { ok: false, text: String(body.error ?? body.message ?? `Stop failed (HTTP ${res.status}).`) };
		} catch (e) {
			note = { ok: false, text: `Stop failed: ${e instanceof Error ? e.message : String(e)}` };
		} finally {
			busy = false;
			// Torque and the servo rows re-read now instead of at their next poll.
			announceBusFree('stop-arm');
		}
	}
</script>

<div class="flex flex-wrap items-center gap-2 border-t px-3 py-1.5 text-[11px]" style="border-color: var(--color-tron-border); color: var(--color-tron-text-secondary)">
	<span>Stop</span>
	<button
		type="button"
		onclick={stop}
		disabled={!armReachable || busy}
		class="rounded px-2 py-0.5 font-semibold disabled:cursor-not-allowed disabled:opacity-40"
		style="background: rgba(239,68,68,0.15); color: #fca5a5; border: 1px solid #ef4444;"
		title={armReachable ? 'Stops whatever the arm is playing and holds it there. Does not touch the OT-2.' : 'The arm is unreachable'}
	>
		{busy ? 'Stopping…' : 'Stop Arm'}
	</button>
	{#if note}
		<span class="basis-full" style="color: {note.ok ? '#4ade80' : '#fca5a5'}">{note.text}</span>
	{/if}
</div>
