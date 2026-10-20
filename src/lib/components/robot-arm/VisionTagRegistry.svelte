<script lang="ts">
	/**
	 * ARM-05 — the tag registry. One row per printed AprilTag stuck somewhere:
	 * its ID (what the camera reads), its size (what turns a detection into
	 * millimetres), whether it is on the arm or fixed, and the operator's own
	 * name and group. Tags are usually registered from the Calibrate preview;
	 * this is for adding by ID, editing and archiving.
	 */
	import { enhance } from '$app/forms';
	import { sheetSizeMm, MAX_TAG_ID } from '$lib/robot-arm/apriltags';
	import type { TagSummary } from '$lib/server/robot-arm-vision';

	interface Props {
		tags: TagSummary[];
	}

	let { tags }: Props = $props();

	let editingId = $state<string | null>(null);
	let showArchived = $state(false);
	let newTagId = $state<number | null>(null);

	const active = $derived(tags.filter((t) => !t.archived));
	const archived = $derived(tags.filter((t) => t.archived));
	const groups = $derived([...new Set(tags.map((t) => t.group).filter((g): g is string => !!g))].sort());
	const byRole = $derived([
		{ role: 'arm', label: 'On the arm', list: active.filter((t) => t.role === 'arm') },
		{ role: 'fixed', label: 'Fixed (camera-shift reference)', list: active.filter((t) => t.role === 'fixed') }
	]);
	const newSize = $derived(newTagId != null ? sheetSizeMm(newTagId) : null);

	const keep = () => async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
		await update();
		editingId = null;
	};

	const input = 'mt-1 w-full rounded border bg-black/40 px-2 py-1 text-sm';
	const inputStyle = 'border-color: var(--color-tron-border); color: var(--color-tron-text)';
</script>

<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
	<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">TAG REGISTRY</h2>
	<p class="max-w-2xl text-xs" style="color: var(--color-tron-text-secondary)">
		AprilTag 36h11 from the printed sheet (services/robot-arm/calibration/apriltag-sheet.pdf). Each ID goes on one spot only.
		Size is the edge of the black square — measure it if the print might be scaled. Put at least one tag on something
		fixed (deck, Opentron) so a bumped camera can be measured and undone.
	</p>

	<datalist id="arm-tag-groups">
		{#each groups as g}<option value={g}></option>{/each}
	</datalist>

	<form method="POST" action="?/createTag" use:enhance class="mt-3 grid gap-2 sm:grid-cols-[6rem_6rem_minmax(0,1.3fr)_minmax(0,2fr)_minmax(0,1.5fr)_auto] sm:items-end">
		<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
			Tag ID
			<input name="tagId" type="number" min="0" max={MAX_TAG_ID} required bind:value={newTagId} class={input} style={inputStyle} />
		</label>
		<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
			Size mm
			<input name="sizeMm" type="number" step="0.1" min="1" max="500" placeholder={newSize != null ? String(newSize) : 'size'} class={input} style={inputStyle} />
		</label>
		<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
			On
			<select name="role" required class={input} style={inputStyle}>
				<option value="arm">the arm</option>
				<option value="fixed">something fixed</option>
			</select>
		</label>
		<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
			Name
			<input name="name" required maxlength="60" placeholder="e.g. Wrist, Deck front-left" class={input} style={inputStyle} />
		</label>
		<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
			Group (optional)
			<input name="group" list="arm-tag-groups" maxlength="40" class={input} style={inputStyle} />
		</label>
		<button type="submit" class="min-h-[34px] rounded px-4 text-sm font-semibold" style="background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);">
			Register
		</button>
	</form>
	<p class="mt-1 text-[11px]" style="color: var(--color-tron-text-secondary)">Leave size empty to use the printed sheet's size for that ID.</p>

	{#if !active.length}
		<p class="mt-3 text-xs" style="color: var(--color-tron-text-secondary)">No tags registered yet — run Detect in Calibrate and register what the camera sees.</p>
	{/if}

	{#each byRole as g (g.role)}
		{#if g.list.length}
			<div class="mt-3">
				<p class="mb-1 text-[11px] font-semibold uppercase tracking-wide" style="color: var(--color-tron-text-secondary)">{g.label}</p>
				<ul class="space-y-1">
					{#each g.list as t (t._id)}
						<li class="rounded border px-2 py-1.5" style="border-color: var(--color-tron-border)">
							{#if editingId === t._id}
								<form method="POST" action="?/updateTag" use:enhance={keep} class="grid gap-2 sm:grid-cols-[5rem_5rem_minmax(0,1.3fr)_minmax(0,2fr)_minmax(0,1.5fr)_auto_auto] sm:items-end">
									<input type="hidden" name="id" value={t._id} />
									<!-- Not edited here, but updateTag rewrites every field. -->
									<input type="hidden" name="notes" value={t.notes ?? ''} />
									<input name="tagId" type="number" min="0" max={MAX_TAG_ID} required value={t.tagId} class={input} style={inputStyle} aria-label="Tag ID" />
									<input name="sizeMm" type="number" step="0.1" min="1" max="500" required value={t.sizeMm} class={input} style={inputStyle} aria-label="Size mm" />
									<select name="role" class={input} style={inputStyle} aria-label="On">
										<option value="arm" selected={t.role === 'arm'}>the arm</option>
										<option value="fixed" selected={t.role === 'fixed'}>something fixed</option>
									</select>
									<input name="name" required maxlength="60" value={t.name} class={input} style={inputStyle} aria-label="Name" />
									<input name="group" list="arm-tag-groups" maxlength="40" value={t.group ?? ''} class={input} style={inputStyle} aria-label="Group" />
									<button type="submit" class="min-h-[30px] rounded px-3 text-xs font-semibold" style="color: #4ade80; border: 1px solid #4ade80;">Save</button>
									<button type="button" onclick={() => (editingId = null)} class="px-2 text-xs" style="color: var(--color-tron-text-secondary)">cancel</button>
								</form>
							{:else}
								<div class="flex flex-wrap items-center gap-2 text-sm">
									<span class="font-mono" style="color: var(--color-tron-text-secondary)">#{t.tagId}</span>
									<button
										type="button"
										onclick={() => (editingId = t._id)}
										title="Rename or edit this tag"
										class="hover:underline"
										style="color: var(--color-tron-text)">{t.name}</button
									>
									<span class="text-xs" style="color: var(--color-tron-text-secondary)">{t.sizeMm} mm{t.group ? ` · ${t.group}` : ''}</span>
									<span class="grow"></span>
									<button type="button" onclick={() => (editingId = t._id)} class="text-xs underline" style="color: var(--color-tron-cyan)">edit</button>
									<form method="POST" action="?/archiveTag" use:enhance>
										<input type="hidden" name="id" value={t._id} />
										<button type="submit" class="text-xs underline" style="color: var(--color-tron-text-secondary)">archive</button>
									</form>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	{/each}

	{#if archived.length}
		<button type="button" onclick={() => (showArchived = !showArchived)} class="mt-3 text-xs underline" style="color: var(--color-tron-text-secondary)">
			{showArchived ? 'Hide' : 'Show'} archived ({archived.length})
		</button>
		{#if showArchived}
			<ul class="mt-1 space-y-1">
				{#each archived as t (t._id)}
					<li class="flex items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
						<span class="font-mono">#{t.tagId}</span>
						{t.name}{t.group ? ` · ${t.group}` : ''}
						<form method="POST" action="?/archiveTag" use:enhance>
							<input type="hidden" name="id" value={t._id} />
							<input type="hidden" name="restore" value="1" />
							<button type="submit" class="underline" style="color: var(--color-tron-cyan)">restore</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</section>
