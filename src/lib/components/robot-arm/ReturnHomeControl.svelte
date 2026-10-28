<script lang="ts">
	/**
	 * Return to home from any Robot Arm tab: a row under Torque at the top of
	 * the ARM CONNECTION card (the card lives in the arm +layout and this row
	 * stays visible when the card is hidden). The Vision tab keeps its fuller
	 * readout (residuals, tags, snapshot); both drive the same ReturnHome loop
	 * (src/lib/robot-arm/return-home.svelte.ts), with the Vision tab's camera.
	 */
	import { ReturnHome, RETURN_HOME_CONFIRM, savedVisionCamera } from '$lib/robot-arm/return-home.svelte';
	import { HOME_LOOP_MS } from '$lib/robot-arm/home-calibration';

	interface Props {
		armReachable: boolean;
	}

	let { armReachable }: Props = $props();

	const rh = new ReturnHome();
	const loop = $derived(rh.loop);

	// The camera is the Vision tab's choice in this browser, read when pressed
	// (not at render: the server render has no storage). Null → the server
	// takes the newest active calibration.
	let camera: string | null = null;

	async function start() {
		if (!confirm(RETURN_HOME_CONFIRM)) return;
		camera = savedVisionCamera();
		await rh.run(camera);
	}

	const status = $derived.by(() => {
		if (!loop) return null;
		if (loop.closing) return 'Closing the claw (final step)…';
		if (loop.running) return `Returning home: attempt ${loop.attempt} · ${Math.round((rh.now - loop.startedAt) / 1000)} s of ${HOME_LOOP_MS / 1000} s${loop.stopping ? ' · stopping (after the current jog), then closing the mouth…' : ''}`;
		if (loop.error) return `${loop.error} (attempt ${loop.attempt})`;
		return `Return to home finished after ${loop.attempt} attempt(s): ${loop.outcome}.`;
	});
</script>

<div class="flex flex-wrap items-center gap-2 border-t px-3 py-1.5 text-[11px]" style="border-color: var(--color-tron-border); color: var(--color-tron-text-secondary)">
	<span>Home</span>
	{#if loop?.running}
		<button
			type="button"
			onclick={() => rh.stop(camera)}
			disabled={loop.stopping}
			class="rounded px-2 py-0.5 font-semibold disabled:cursor-not-allowed disabled:opacity-40"
			style="background: rgba(239,68,68,0.15); color: #fca5a5; border: 1px solid #ef4444;"
			title="Stops within one jog, then closes the mouth"
		>
			Stop returning
		</button>
	{:else}
		<button
			type="button"
			onclick={start}
			disabled={!armReachable}
			class="rounded px-2 py-0.5 font-semibold disabled:cursor-not-allowed disabled:opacity-40"
			style="background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid #f59e0b;"
			title={armReachable
				? 'The arm MOVES: open the mouth, servo 2 home, all joints home, close the claw; keeps going until done (Stop any time; max 90 s). Uses the Vision tab’s camera and calibration; refused while a session holds the arm.'
				: 'The arm is unreachable'}
		>
			Return to home
		</button>
	{/if}
	{#if status}
		<span class="basis-full" style="color: {loop?.error ? '#fca5a5' : 'var(--color-tron-text-secondary)'}">{status}</span>
	{/if}
	{#if loop && !loop.running && !loop.frozen}
		<span class="basis-full" style="color: {loop.clawClosed ? '#4ade80' : '#fca5a5'}">
			{loop.clawClosed ? 'Claw closed.' : `Claw NOT confirmed closed${loop.clawError ? `: ${loop.clawError}` : '.'}`}
		</span>
	{/if}
	{#if rh.result?.frozen}
		<span class="basis-full rounded border border-red-500/60 bg-red-900/20 p-2 text-red-200">
			FROZEN — return the arm to home by hand. {rh.result.message}
		</span>
	{:else if loop && !loop.running && rh.result}
		<span class="basis-full">{rh.result.message}</span>
	{/if}
</div>
