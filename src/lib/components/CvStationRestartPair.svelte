<script lang="ts">
	// Fullscreen tablet strip: CV Station 1 as a square Restart button at the
	// far left, Station 2 at the far right. Each button is as tall as the strip
	// and as wide as it is tall. Labels as dictated (2026-11-10).
	import { restartStationAgent } from './cv-station-restart';

	type Station = { _id: string; name: string; hostname: string };
	let { stations }: { stations: Station[] } = $props();

	const left = $derived(stations.find((s) => s.name === 'CV Station 1') ?? null);
	const right = $derived(stations.find((s) => s.name === 'CV Station 2') ?? null);

	let busy = $state<Record<string, boolean>>({});
	let result = $state<Record<string, { ok: boolean; text: string }>>({});

	async function restart(s: Station) {
		if (busy[s._id]) return;
		busy[s._id] = true;
		delete result[s._id];
		try {
			await restartStationAgent(s._id, s.hostname);
			result[s._id] = { ok: true, text: 'Restart Sent' };
		} catch (e) {
			result[s._id] = {
				ok: false,
				text: `Restart Failed: ${e instanceof Error ? e.message : String(e)}`
			};
		} finally {
			busy[s._id] = false;
		}
	}
</script>

{#snippet square(s: Station)}
	<button
		type="button"
		onclick={() => restart(s)}
		disabled={busy[s._id]}
		class="aspect-square h-full shrink-0 rounded-lg border-4 border-[var(--color-tron-red,#ff3366)] text-2xl font-bold text-[var(--color-tron-red,#ff3366)] active:bg-[rgba(255,51,102,0.2)] disabled:opacity-50"
	>
		{busy[s._id] ? 'Restarting' : 'Restart'}
	</button>
{/snippet}

{#snippet label(s: Station, text: string, alignRight: boolean)}
	<div class="flex min-w-0 flex-col justify-center gap-1 {alignRight ? 'items-end text-right' : ''}">
		<span class="text-2xl font-semibold text-white">{text}</span>
		{#if result[s._id]}
			<span
				class="text-sm"
				style="color:{result[s._id].ok
					? 'var(--color-tron-green,#39ff14)'
					: 'var(--color-tron-red,#ff3366)'}"
			>
				{result[s._id].text}
			</span>
		{/if}
	</div>
{/snippet}

<div class="flex h-full min-h-0 items-stretch justify-between gap-4 py-2">
	<div class="flex h-full min-w-0 items-stretch gap-4">
		{#if left}
			{@render square(left)}
			{@render label(left, 'CV Station 1', false)}
		{/if}
	</div>
	<div class="flex h-full min-w-0 items-stretch gap-4">
		{#if right}
			{@render label(right, 'Station 2', true)}
			{@render square(right)}
		{/if}
	</div>
</div>
