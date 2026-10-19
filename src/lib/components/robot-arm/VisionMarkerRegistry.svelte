<script lang="ts">
	/**
	 * ARM-04 — the marker registry. Nothing is predefined: every marker and
	 * every group is the operator's own, one per physical sticker.
	 */
	import { enhance } from '$app/forms';
	import { rgbToHex, isLowSaturation } from '$lib/robot-arm/markers';
	import type { MarkerSummary } from '$lib/server/robot-arm-vision';

	interface Props {
		markers: MarkerSummary[];
	}

	let { markers }: Props = $props();

	let editingId = $state<string | null>(null);
	let showArchived = $state(false);
	let newColor = $state('#ff2d55');

	const active = $derived(markers.filter((m) => !m.archived));
	const archived = $derived(markers.filter((m) => m.archived));
	const groups = $derived([...new Set(markers.map((m) => m.group).filter((g): g is string => !!g))].sort());
	const grouped = $derived.by(() => {
		const map = new Map<string, MarkerSummary[]>();
		for (const m of active) {
			const k = m.group ?? '';
			if (!map.has(k)) map.set(k, []);
			map.get(k)!.push(m);
		}
		return [...map.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
	});
	const newColorGrey = $derived.by(() => {
		const n = parseInt(newColor.slice(1), 16);
		return Number.isFinite(n) && isLowSaturation({ r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 });
	});

	const keep = () => async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
		await update();
		editingId = null;
	};

	const input = 'mt-1 w-full rounded border bg-black/40 px-2 py-1 text-sm';
	const inputStyle = 'border-color: var(--color-tron-border); color: var(--color-tron-text)';
</script>

<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
	<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">MARKER REGISTRY</h2>
	<p class="max-w-2xl text-xs" style="color: var(--color-tron-text-secondary)">
		One marker per coloured sticker, named and grouped however you like. Vivid, distinct colours track best; two
		stickers of the same colour work as long as they are not right next to each other.
	</p>

	<datalist id="arm-marker-groups">
		{#each groups as g}<option value={g}></option>{/each}
	</datalist>

	<form method="POST" action="?/createMarker" use:enhance class="mt-3 grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_auto_minmax(0,2fr)_auto] sm:items-end">
		<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
			Name
			<input name="name" required maxlength="60" placeholder="e.g. Wrist joint" class={input} style={inputStyle} />
		</label>
		<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
			Group (optional)
			<input name="group" list="arm-marker-groups" maxlength="40" placeholder="your own" class={input} style={inputStyle} />
		</label>
		<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
			Sticker colour
			<input name="color" type="color" bind:value={newColor} class="mt-1 block h-[30px] w-14 cursor-pointer rounded border bg-transparent" style="border-color: var(--color-tron-border)" />
		</label>
		<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
			Notes (optional)
			<input name="notes" maxlength="200" placeholder="where it is stuck" class={input} style={inputStyle} />
		</label>
		<button type="submit" class="min-h-[34px] rounded px-4 text-sm font-semibold" style="background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);">
			Register
		</button>
	</form>
	{#if newColorGrey}
		<p class="mt-1 text-xs" style="color: #f59e0b">That colour is close to grey/white/black — it can only be tracked by brightness, which is much less reliable. Prefer a vivid sticker.</p>
	{/if}

	{#if !active.length}
		<p class="mt-3 text-xs" style="color: var(--color-tron-text-secondary)">No markers registered yet.</p>
	{/if}

	{#each grouped as [group, list] (group)}
		<div class="mt-3">
			<p class="mb-1 text-[11px] font-semibold uppercase tracking-wide" style="color: var(--color-tron-text-secondary)">{group || 'Ungrouped'}</p>
			<ul class="space-y-1">
				{#each list as m (m._id)}
					<li class="rounded border px-2 py-1.5" style="border-color: var(--color-tron-border)">
						{#if editingId === m._id}
							<form method="POST" action="?/updateMarker" use:enhance={keep} class="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_auto_minmax(0,2fr)_auto_auto] sm:items-end">
								<input type="hidden" name="id" value={m._id} />
								<input name="name" required maxlength="60" value={m.name} class={input} style={inputStyle} aria-label="Name" />
								<input name="group" list="arm-marker-groups" maxlength="40" value={m.group ?? ''} class={input} style={inputStyle} aria-label="Group" />
								<input name="color" type="color" value={rgbToHex(m.color)} class="mt-1 block h-[30px] w-14 cursor-pointer rounded border bg-transparent" style="border-color: var(--color-tron-border)" aria-label="Sticker colour" />
								<input name="notes" maxlength="200" value={m.notes ?? ''} class={input} style={inputStyle} aria-label="Notes" />
								<button type="submit" class="min-h-[30px] rounded px-3 text-xs font-semibold" style="color: #4ade80; border: 1px solid #4ade80;">Save</button>
								<button type="button" onclick={() => (editingId = null)} class="px-2 text-xs" style="color: var(--color-tron-text-secondary)">cancel</button>
							</form>
						{:else}
							<div class="flex flex-wrap items-center gap-2 text-sm">
								<span class="inline-block h-4 w-4 rounded-full border" style="background: {rgbToHex(m.color)}; border-color: var(--color-tron-border)"></span>
								<span style="color: var(--color-tron-text)">{m.name}</span>
								{#if m.notes}<span class="text-xs" style="color: var(--color-tron-text-secondary)">{m.notes}</span>{/if}
								<span class="grow"></span>
								<button type="button" onclick={() => (editingId = m._id)} class="text-xs underline" style="color: var(--color-tron-cyan)">edit</button>
								<form method="POST" action="?/archiveMarker" use:enhance>
									<input type="hidden" name="id" value={m._id} />
									<button type="submit" class="text-xs underline" style="color: var(--color-tron-text-secondary)">archive</button>
								</form>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/each}

	{#if archived.length}
		<button type="button" onclick={() => (showArchived = !showArchived)} class="mt-3 text-xs underline" style="color: var(--color-tron-text-secondary)">
			{showArchived ? 'Hide' : 'Show'} archived ({archived.length})
		</button>
		{#if showArchived}
			<ul class="mt-1 space-y-1">
				{#each archived as m (m._id)}
					<li class="flex items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
						<span class="inline-block h-3 w-3 rounded-full" style="background: {rgbToHex(m.color)}"></span>
						{m.name}{m.group ? ` · ${m.group}` : ''}
						<form method="POST" action="?/archiveMarker" use:enhance>
							<input type="hidden" name="id" value={m._id} />
							<input type="hidden" name="restore" value="1" />
							<button type="submit" class="underline" style="color: var(--color-tron-cyan)">restore</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</section>
