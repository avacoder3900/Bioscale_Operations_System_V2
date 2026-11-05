<script lang="ts">
	/**
	 * The one line under a play (2026-11-05, Alejandro): a bordered chip that
	 * reads "Move to <pose>: In Progress" in grey while the arm moves and
	 * "Move to <pose>: Complete" in blue once it has finished. The same chip
	 * serves a move-set or sequence play (its title is the name). A stop or a
	 * play the Pi never confirmed is amber with the detail under it; an error
	 * is red.
	 */
	import type { Playback } from '$lib/robot-arm/playback.svelte';

	interface Props {
		playback: Playback;
		/** Draw a Stop button in the chip (pages without one in their header). */
		onstop?: () => void;
	}
	let { playback, onstop }: Props = $props();

	type Kind = 'starting' | 'running' | 'complete' | 'stopped' | 'unconfirmed' | 'error';
	const kind = $derived.by((): Kind | null => {
		if (playback.error) return 'error';
		if (playback.running) return 'running';
		if (playback.busy) return 'starting';
		if (playback.outcome === 'finished') return 'complete';
		if (playback.outcome?.startsWith('stopped')) return 'stopped';
		if (playback.outcome) return 'unconfirmed';
		return null;
	});
	const text = $derived.by(() => {
		switch (kind) {
			case 'starting':
				return 'Starting';
			case 'running':
				return `${playback.title}: In Progress`;
			case 'complete':
				return `${playback.title}: Complete`;
			case 'stopped':
				return `${playback.title}: Stopped`;
			case 'unconfirmed':
				return `${playback.title}: Not Confirmed`;
			case 'error':
				return playback.error ?? 'Error';
			default:
				return '';
		}
	});
	/** The long outcome text behind a stop / give-up, shown small under the chip line. */
	const detail = $derived(kind === 'stopped' || kind === 'unconfirmed' ? playback.outcome : null);
	const warn = $derived(kind === 'stopped' || kind === 'unconfirmed');
	const color = $derived(kind === 'complete' ? 'var(--color-tron-cyan)' : kind === 'error' ? '#fca5a5' : warn ? '#fbbf24' : '#cbd5e1');
	const border = $derived(kind === 'complete' ? 'var(--color-tron-cyan)' : kind === 'error' ? '#ef4444' : warn ? '#f59e0b' : 'rgba(148,163,184,0.6)');
</script>

{#if kind}
	<div class="rounded border px-3 py-2 text-sm" style="border-color: {border}; color: {color}; background: var(--color-tron-surface);" role="status">
		<div class="flex flex-wrap items-center gap-3">
			<span class="font-semibold">{text}</span>
			{#if kind === 'running'}
				<span class="font-mono text-xs">{playback.elapsedS.toFixed(0)} / {playback.durationS.toFixed(1)} s{playback.leadInS ? ` (lead-in ${playback.leadInS} s first)` : ''}</span>
			{/if}
			{#if onstop && kind === 'running'}
				<span class="grow"></span>
				<button
					type="button"
					class="min-h-[38px] rounded px-4 text-sm font-semibold disabled:opacity-40"
					style="background: rgba(239,68,68,0.15); color: #fca5a5; border: 1px solid #ef4444;"
					onclick={onstop}
					disabled={playback.busy}>Stop</button
				>
			{/if}
		</div>
		{#if detail}<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">{detail}</p>{/if}
		{#if playback.settled}<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">{playback.settled}</p>{/if}
		{#if playback.warnings.length}<p class="mt-1 text-xs" style="color: #f59e0b">{playback.warnings.join(' ')}</p>{/if}
	</div>
{/if}
