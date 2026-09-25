<!--
  Which line this page is using to reach the robot (OT2-TAILNET-4).
    direct  green  — browser ↔ robot over Tailscale
    busy    amber  — direct, but a daemon job (sweep / deck scan / tip cal) holds
                     the gantry, so motion is going through the queue
    queue   grey   — the Vercel queue (today's path); tooltip says why
  After a fallback, offers "retry direct" (the session never flips back by itself).
-->
<script lang="ts">
	import type { RobotSessionState } from '$lib/opentrons/direct-client';

	let { state, onRetry }: { state: RobotSessionState | null; onRetry?: () => void } = $props();

	let kind = $derived(
		!state || state.transport === 'opening'
			? 'opening'
			: state.transport === 'direct'
				? state.busy
					? 'busy'
					: 'direct'
				: 'queue'
	);
	let label = $derived(
		kind === 'direct'
			? `direct${state?.latencyMs != null ? ` · ${state.latencyMs} ms` : ''}`
			: kind === 'busy'
				? `busy · ${state?.busy?.kind?.replace('_', ' ')}`
				: kind === 'queue'
					? state?.fellBack
						? 'queue (fell back)'
						: 'queue'
					: '…'
	);
	let title = $derived(
		kind === 'busy'
			? `Direct link up, but a ${state?.busy?.kind} job is running on the robot — motion goes through the queue so it can't collide with it.`
			: (state?.reason ?? 'checking connection…')
	);
	let cls = $derived(
		kind === 'direct'
			? 'border-green-500/40 bg-green-900/30 text-green-300'
			: kind === 'busy'
				? 'border-amber-500/40 bg-amber-900/30 text-amber-300'
				: 'border-[var(--color-tron-border)] bg-black/30 text-[var(--color-tron-text-secondary)]'
	);
</script>

<span class="inline-flex items-center gap-1.5">
	<span class="rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider {cls}" {title} data-transport={kind}>
		{label}
	</span>
	{#if state?.fellBack && state.tailnetConfigured && onRetry}
		<button type="button" class="text-[10px] text-[var(--color-tron-cyan)] hover:underline" onclick={onRetry}>retry direct</button>
	{/if}
</span>
