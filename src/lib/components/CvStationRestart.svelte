<script lang="ts">
	import { restartStationAgent } from './cv-station-restart';

	type Station = { _id: string; name: string; hostname: string };
	let { stations }: { stations: Station[] } = $props();

	const sorted = $derived(
		[...stations].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
	);

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

<div class="flex flex-col gap-1">
	{#each sorted as s (s._id)}
		<div class="flex items-center gap-2 text-xs">
			<span class="text-[var(--color-tron-text-secondary)]">{s.name}:</span>
			<button
				type="button"
				onclick={() => restart(s)}
				disabled={busy[s._id]}
				class="rounded border border-[var(--color-tron-red,#ff3366)] px-2 py-0.5 text-[var(--color-tron-red,#ff3366)] hover:bg-[rgba(255,51,102,0.12)] disabled:opacity-50"
			>
				{busy[s._id] ? 'Restarting' : 'Restart'}
			</button>
			{#if result[s._id]}
				<span
					class="text-[10px]"
					style="color:{result[s._id].ok
						? 'var(--color-tron-green,#39ff14)'
						: 'var(--color-tron-red,#ff3366)'}"
				>
					{result[s._id].text}
				</span>
			{/if}
		</div>
	{/each}
</div>
